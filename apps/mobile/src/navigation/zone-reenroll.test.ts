// Voluntary re-enrolment's place in the gate (task 168, D27) — the PRECEDENCE tests.
//
// `resolveZone`'s ordering is a stated security property, not a style choice, so a new input into it
// is a security change and gets adversarial coverage before review (CLAUDE.md §2.5). Every test here
// is an attempt to make `reenrolling` win somewhere it must not.
import { expect, test } from 'vitest';

import { backTarget, resolveZone, type ZoneInput } from './zone.js';

function input(overrides: Partial<ZoneInput> = {}): ZoneInput {
  return {
    device: 'active',
    session: null,
    locked: false,
    pinFor: null,
    reenrolling: false,
    switching: false,
    route: 'home',
    ...overrides,
  };
}

test('an active device with no session opens the wizard when the user asks to re-enrol', () => {
  const zone = resolveZone(input({ reenrolling: true }));
  expect(zone).toEqual({ kind: 'enrollment', revoked: false, voluntary: true });
});

test('an IDLE LOCK beats re-enrolling', () => {
  // The precedence that matters most: `reenrolling` is shell state that can outlive the moment it was
  // set. If it beat a lock, a tap before an idle lock would render the enrolment wizard OVER a locked
  // device — a logged-out surface serving an unlocked-looking flow.
  const zone = resolveZone(input({ reenrolling: true, locked: true }));
  expect(zone.kind).toBe('switcher');
  expect(zone).toMatchObject({ mode: 'lock' });
});

test('a pending PIN beats re-enrolling', () => {
  // Picking a face is a later step than asking to re-enrol; the pad must not be replaced underneath
  // someone mid-entry.
  const zone = resolveZone(input({ reenrolling: true, pinFor: 'user-a' }));
  expect(zone).toMatchObject({ kind: 'pin', userId: 'user-a' });
});

test('a REVOKED device still routes to the forced wizard, never the voluntary one', () => {
  // Device status is terminal and checked first. A revoked device reaching the VOLUNTARY flow would
  // be a real escalation: `voluntary` makes the wizard abandonable back to the switcher, which on a
  // revoked device is a surface it must never return to.
  const zone = resolveZone(input({ reenrolling: true, device: 'revoked' }));
  expect(zone).toEqual({ kind: 'enrollment', revoked: true, voluntary: false });
});

test('an UNENROLLED device still routes to the forced wizard', () => {
  const zone = resolveZone(input({ reenrolling: true, device: 'unenrolled' }));
  expect(zone).toEqual({ kind: 'enrollment', revoked: false, voluntary: false });
});

test('an OPEN SESSION beats re-enrolling — the flow is empty-roster only', () => {
  // The control lives on the empty-roster switcher, which is a no-session surface. A live session
  // must never be displaced by stale `reenrolling` state.
  const zone = resolveZone(input({ reenrolling: true, session: { userId: 'user-a' } }));
  expect(zone).toMatchObject({ kind: 'shell' });
});

test('the voluntary wizard is abandonable; the forced one is not', () => {
  // The behavioural difference `voluntary` exists to carry. Stranding a user in a wizard they chose
  // to open, on a device that still works, would be a worse trap than the empty roster.
  expect(backTarget({ kind: 'enrollment', revoked: false, voluntary: true })).toEqual({
    kind: 'switcher',
  });
  expect(backTarget({ kind: 'enrollment', revoked: false, voluntary: false })).toBeNull();
  expect(backTarget({ kind: 'enrollment', revoked: true, voluntary: false })).toBeNull();
});

test('a revoked device can never reach an abandonable wizard, by construction', () => {
  // Composed statement of the two rules above: whatever the shell state, a revoked device's zone is
  // never `voluntary`, so `backTarget` can never hand it a way back to the switcher.
  for (const locked of [true, false])
    for (const reenrolling of [true, false])
      for (const pinFor of [null, 'user-a']) {
        const zone = resolveZone(input({ device: 'revoked', locked, reenrolling, pinFor }));
        expect(zone).toMatchObject({ kind: 'enrollment', voluntary: false });
        expect(backTarget(zone)).toBeNull();
      }
});
