// Render-boundary test for ClearLockoutScreen (task 138 item 1; the layer model.test.ts cannot see).
//
// `clear-lockout.model.test.ts` proves `clearActionReducer` and `clearLockoutOutcome` in isolation.
// It cannot see whether the SCREEN wires the submit effect's reject through `clearLockoutOutcome`, or
// whether the Unauthorized/Empty §5 states actually render. This file mounts the real screen.
//
// FALSIFIED (§2.11): mapping the reject to `{ ok: true }` at ClearLockoutScreen.tsx reds the "a
// rejected unlock shows failure" test while model.test.ts stays green. The resolve positive control
// (T-14b) proves the green comes from the wire, not a screen that can never reach `done`.
import { DomainError } from '@bolusi/core';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render } from '../../../../../packages/ui/test/render.js';

import { ClearLockoutScreen } from './ClearLockoutScreen.js';
import type { PinTargetUser } from './pin-target.js';

const LOCKED: PinTargetUser = { id: 'u-ani', name: 'Ani', lockedOut: true };
const OPEN: PinTargetUser = { id: 'u-budi', name: 'Budi', lockedOut: false };

function base(over: Partial<Parameters<typeof ClearLockoutScreen>[0]> = {}) {
  return {
    canUnlock: true,
    loading: false,
    error: null,
    users: [LOCKED, OPEN],
    onClearLockout: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...over,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ClearLockoutScreen §5 states — a non-owner sees Unauthorized, never the list', () => {
  test('without auth.pin_unlock the target list is NOT rendered (denial ≠ empty)', () => {
    const screen = render(<ClearLockoutScreen {...base({ canUnlock: false })} />);
    // No locked user is offered, and the list is not shown — the Unauthorized state stands in.
    expect(screen.query(`clear-lockout-target-${LOCKED.id}`)).toBeNull();
  });

  test('an owner sees only the LOCKED user as a target, never the unlocked one', () => {
    const screen = render(<ClearLockoutScreen {...base()} />);
    expect(screen.query(`clear-lockout-target-${LOCKED.id}`)).not.toBeNull();
    expect(screen.query(`clear-lockout-target-${OPEN.id}`)).toBeNull();
  });
});

describe('ClearLockoutScreen wires the flow reject through — a rejected unlock is never a success', () => {
  test('confirm is required: picking a target opens the sheet but does not clear', () => {
    const onClearLockout = vi.fn(() => Promise.resolve());
    const screen = render(<ClearLockoutScreen {...base({ onClearLockout })} />);
    fire(screen.get(`clear-lockout-target-${LOCKED.id}`), 'onPress');
    expect(screen.query('clear-lockout-confirm')).not.toBeNull();
    expect(onClearLockout).not.toHaveBeenCalled();
  });

  test('onClearLockout REJECTS (target no longer locked) → failure shown, NOT the done panel', async () => {
    const onClearLockout = vi.fn(() => Promise.reject(new DomainError('INVALID_TRANSITION')));
    const screen = render(<ClearLockoutScreen {...base({ onClearLockout })} />);

    fire(screen.get(`clear-lockout-target-${LOCKED.id}`), 'onPress');
    fire(screen.get('clear-lockout-confirm.confirm'), 'onPress');
    await flush();

    expect(onClearLockout).toHaveBeenCalledWith(LOCKED.id);
    // The line that reds if the reject is mapped to `{ ok: true }`.
    expect(screen.query('clear-lockout-done')).toBeNull();
    expect(screen.query('clear-lockout-failed')).not.toBeNull();
  });

  test('POSITIVE CONTROL: onClearLockout RESOLVES → the done panel IS shown', async () => {
    const onClearLockout = vi.fn(() => Promise.resolve());
    const screen = render(<ClearLockoutScreen {...base({ onClearLockout })} />);

    fire(screen.get(`clear-lockout-target-${LOCKED.id}`), 'onPress');
    fire(screen.get('clear-lockout-confirm.confirm'), 'onPress');
    await flush();

    expect(screen.query('clear-lockout-done')).not.toBeNull();
    expect(screen.query('clear-lockout-failed')).toBeNull();
  });
});
