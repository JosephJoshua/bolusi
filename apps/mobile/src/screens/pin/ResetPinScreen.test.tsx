// Render-boundary test for ResetPinScreen (task 138 item 1; the layer model.test.ts cannot see).
//
// `reset-pin.model.test.ts` proves `resetPinReducer` and `resetOutcome` in isolation. It cannot see
// whether the SCREEN wires the submit effect's reject through `resetOutcome`, whether the §5
// Unauthorized state renders for a non-owner, or whether the target's typed PIN is ever echoed as
// text (the §6.6 "owner never learns it" property). This file mounts the real screen.
//
// FALSIFIED (§2.11): mapping the reject to `{ ok: true }` at ResetPinScreen.tsx reds the "a rejected
// reset shows failure" test while model.test.ts stays green. The resolve positive control (T-14b)
// keeps the reject test honest.
import { DomainError } from '@bolusi/core';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { ResetPinScreen } from './ResetPinScreen.js';
import type { PinTargetUser } from './pin-target.js';

const OWNER: PinTargetUser = { id: 'u-owner', name: 'Ocep', lockedOut: false };
const STAFF: PinTargetUser = { id: 'u-staff', name: 'Ani', lockedOut: false };
const PAD = 'reset-pin-pad';
const NEW_PIN = '345678';

function base(over: Partial<Parameters<typeof ResetPinScreen>[0]> = {}) {
  return {
    canReset: true,
    loading: false,
    error: null,
    users: [OWNER, STAFF],
    actorUserId: OWNER.id,
    onResetPin: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...over,
  };
}

function enterPin(screen: ReturnType<typeof render>, pin: string): void {
  for (const digit of pin) fire(screen.get(`${PAD}.key.${digit}`), 'onPress');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** pick STAFF → hand over → target types + repeats NEW_PIN → submit effect fires onResetPin. */
function resetStaff(screen: ReturnType<typeof render>): void {
  fire(screen.get(`reset-pin-target-${STAFF.id}`), 'onPress'); // → handOver
  fire(screen.get('reset-pin-proceed'), 'onPress'); // → entering
  enterPin(screen, NEW_PIN); // new
  enterPin(screen, NEW_PIN); // repeat (matches) → submitting
}

describe('ResetPinScreen §5 states + the acting owner is not a target', () => {
  test('without auth.user_reset_pin the target list is NOT rendered (denial ≠ empty)', () => {
    const screen = render(<ResetPinScreen {...base({ canReset: false })} />);
    expect(screen.query(`reset-pin-target-${STAFF.id}`)).toBeNull();
  });

  test('the acting owner is never their own reset target', () => {
    const screen = render(<ResetPinScreen {...base()} />);
    expect(screen.query(`reset-pin-target-${STAFF.id}`)).not.toBeNull();
    expect(screen.query(`reset-pin-target-${OWNER.id}`)).toBeNull();
  });
});

describe('ResetPinScreen — the target types the PIN, and a rejected reset is never a success', () => {
  test('the owner never sees the PIN: the entered digits are never rendered as text (§6.6)', () => {
    const screen = render(<ResetPinScreen {...base()} />);
    fire(screen.get(`reset-pin-target-${STAFF.id}`), 'onPress');
    fire(screen.get('reset-pin-proceed'), 'onPress');
    enterPin(screen, NEW_PIN);
    // The pad renders dots, never the value (PinPad's one-egress contract). No text node echoes it.
    expect(textsIn(screen.container)).not.toContain(NEW_PIN);
  });

  test('onResetPin REJECTS (privileged-target denial) → failure shown, NOT the done panel', async () => {
    const onResetPin = vi.fn(() =>
      Promise.reject(new DomainError('PERMISSION_DENIED', { reason: 'restriction_violated' })),
    );
    const screen = render(<ResetPinScreen {...base({ onResetPin })} />);

    resetStaff(screen);
    await flush();

    expect(onResetPin).toHaveBeenCalledWith(STAFF.id, NEW_PIN);
    // The line that reds if the reject is mapped to `{ ok: true }`.
    expect(screen.query('reset-pin-done')).toBeNull();
    expect(screen.query('reset-pin-failed')).not.toBeNull();
  });

  test('POSITIVE CONTROL: onResetPin RESOLVES → the done panel IS shown', async () => {
    const onResetPin = vi.fn(() => Promise.resolve());
    const screen = render(<ResetPinScreen {...base({ onResetPin })} />);

    resetStaff(screen);
    await flush();

    expect(screen.query('reset-pin-done')).not.toBeNull();
    expect(screen.query('reset-pin-failed')).toBeNull();
  });
});
