// "PIN karyawan": the owner picks a person, then unlocks their PIN or has them make a new one. Mounts
// the real screen to prove the person-first flow reaches the right core call for the right person,
// that a refused call never shows success, and that the owner only sees what they may do.
import { DomainError } from '@bolusi/core';
import { t } from '@bolusi/i18n';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import { StaffPinScreen, type StaffPinScreenProps } from './StaffPinScreen.js';

const OWNER = 'user-owner';
const LOCKED: PinTargetUser = { id: 'user-locked', name: 'Yosua Kogoya', lockedOut: true };
const ACTIVE: PinTargetUser = { id: 'user-active', name: 'Andi Pratama', lockedOut: false };

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderStaff(over: Partial<StaffPinScreenProps> = {}) {
  const props: StaffPinScreenProps = {
    canUnlock: true,
    canReset: true,
    loading: false,
    error: null,
    users: [ACTIVE, LOCKED, { id: OWNER, name: 'Paulus Owner', lockedOut: false }],
    actorUserId: OWNER,
    onClearLockout: vi.fn(() => Promise.resolve()),
    onResetPin: vi.fn(() => Promise.resolve()),
    onReload: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { screen: render(<StaffPinScreen {...props} />), props };
}

function press(screen: ReturnType<typeof render>, testID: string): void {
  fire(screen.get(testID), 'onPress');
}

describe('the staff list', () => {
  test('lists colleagues with the locked one first and marked, and never the owner themself', () => {
    const { screen } = renderStaff();
    const list = textsIn(screen.get('staff-pin-list')).join(' | ');
    expect(list.indexOf(LOCKED.name)).toBeLessThan(list.indexOf(ACTIVE.name));
    expect(screen.query(`staff-pin-locked-${LOCKED.id}`)).not.toBeNull();
    expect(screen.query(`staff-pin-locked-${ACTIVE.id}`)).toBeNull();
    expect(screen.query(`staff-pin-target-${OWNER}`)).toBeNull();
  });

  test('without either owner permission the list is not shown at all', () => {
    const { screen } = renderStaff({ canUnlock: false, canReset: false });
    expect(screen.query(`staff-pin-target-${LOCKED.id}`)).toBeNull();
  });
});

describe('unlock', () => {
  test('locked person → unlock → confirm clears THAT person, then shows done', async () => {
    const { screen, props } = renderStaff();
    press(screen, `staff-pin-target-${LOCKED.id}`);
    expect(screen.query('staff-pin-person-locked')).not.toBeNull();

    press(screen, 'staff-pin-unlock');
    // Nothing runs before the owner confirms.
    expect(props.onClearLockout).not.toHaveBeenCalled();
    press(screen, 'staff-pin-unlock-confirm.confirm');
    await flush();

    expect(props.onClearLockout).toHaveBeenCalledExactlyOnceWith(LOCKED.id);
    expect(screen.query('staff-pin-unlock-done')).not.toBeNull();
  });

  test('a refused unlock shows the failure, never done', async () => {
    const { screen } = renderStaff({
      onClearLockout: vi.fn(() => Promise.reject(new DomainError('PERMISSION_DENIED'))),
    });
    press(screen, `staff-pin-target-${LOCKED.id}`);
    press(screen, 'staff-pin-unlock');
    press(screen, 'staff-pin-unlock-confirm.confirm');
    await flush();

    expect(screen.query('staff-pin-unlock-done')).toBeNull();
    expect(screen.query('staff-pin-unlock-failed')).not.toBeNull();
  });

  test('a person who is not locked is not offered an unlock', () => {
    const { screen } = renderStaff();
    press(screen, `staff-pin-target-${ACTIVE.id}`);
    expect(screen.query('staff-pin-unlock')).toBeNull();
    expect(screen.query('staff-pin-reset')).not.toBeNull();
  });
});

describe('reset', () => {
  function enterPin(screen: ReturnType<typeof render>, pin: string): void {
    for (const digit of pin) press(screen, `staff-pin-entry-pad.key.${digit}`);
  }

  test('hand over, the colleague types a new PIN twice, and it is set for THAT person', async () => {
    const { screen, props } = renderStaff();
    press(screen, `staff-pin-target-${ACTIVE.id}`);
    press(screen, 'staff-pin-reset');
    // The owner is asked to hand the phone over before any pad appears.
    expect(screen.query('staff-pin-handover')).not.toBeNull();
    expect(screen.query('staff-pin-entry-pad')).toBeNull();

    press(screen, 'staff-pin-proceed');
    enterPin(screen, '730215');
    enterPin(screen, '730215');
    await flush();

    expect(props.onResetPin).toHaveBeenCalledExactlyOnceWith(ACTIVE.id, '730215');
    expect(screen.query('staff-pin-reset-done')).not.toBeNull();
  });

  test('a re-render with new callbacks mid-save runs the reset once and still reaches done', async () => {
    let finish: () => void = () => undefined;
    const onResetPin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { screen, props } = renderStaff({ onResetPin });
    press(screen, `staff-pin-target-${ACTIVE.id}`);
    press(screen, 'staff-pin-reset');
    press(screen, 'staff-pin-proceed');
    enterPin(screen, '730215');
    enterPin(screen, '730215');
    await flush();
    const fresh = vi.fn(() => Promise.resolve());
    screen.rerender(<StaffPinScreen {...props} onResetPin={fresh} />);
    await flush();
    finish();
    await flush();

    expect(onResetPin).toHaveBeenCalledOnce();
    expect(fresh).not.toHaveBeenCalled();
    expect(screen.query('staff-pin-reset-done')).not.toBeNull();
  });

  test('a refused reset shows the failure, never done', async () => {
    const { screen } = renderStaff({
      onResetPin: vi.fn(() => Promise.reject(new DomainError('PERMISSION_DENIED'))),
    });
    press(screen, `staff-pin-target-${ACTIVE.id}`);
    press(screen, 'staff-pin-reset');
    press(screen, 'staff-pin-proceed');
    enterPin(screen, '730215');
    enterPin(screen, '730215');
    await flush();

    expect(screen.query('staff-pin-reset-done')).toBeNull();
    expect(screen.query('staff-pin-reset-failed')).not.toBeNull();
  });

  test('an owner who may only unlock is not offered a reset', () => {
    const { screen } = renderStaff({ canReset: false });
    press(screen, `staff-pin-target-${LOCKED.id}`);
    expect(screen.query('staff-pin-unlock')).not.toBeNull();
    expect(screen.query('staff-pin-reset')).toBeNull();
  });
});

describe('back steps back inside the flow', () => {
  test('person page → list → closes the screen', () => {
    const { screen, props } = renderStaff();
    press(screen, `staff-pin-target-${LOCKED.id}`);
    expect(screen.query('staff-pin-person')).not.toBeNull();

    press(screen, 'staff-pin-screen.back');
    expect(screen.query('staff-pin-person')).toBeNull();
    expect(screen.query('staff-pin-list')).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();

    press(screen, 'staff-pin-screen.back');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('opened for one person from Karyawan', () => {
  function enterPin(screen: ReturnType<typeof render>, pin: string): void {
    for (const digit of pin) press(screen, `staff-pin-entry-pad.key.${digit}`);
  }

  const NEW: PinTargetUser = {
    id: 'user-new',
    name: 'Rina Wenda',
    lockedOut: false,
    needsFirstPin: true,
  };

  test('goes straight to their hand-over, and finishing closes the screen', async () => {
    const { screen, props } = renderStaff({ startWith: NEW.id, users: [ACTIVE, NEW] });
    await flush();
    expect(screen.query('staff-pin-list')).toBeNull();
    expect(textsIn(screen.get('staff-pin-handover')).join(' ')).toContain(NEW.name);

    press(screen, 'staff-pin-proceed');
    enterPin(screen, '481516');
    enterPin(screen, '481516');
    await flush();
    expect(props.onResetPin).toHaveBeenCalledExactlyOnceWith(NEW.id, '481516');

    press(screen, 'staff-pin-reset-finish');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test('backing out of the hand-over returns to Karyawan, not the PIN list', async () => {
    const { screen, props } = renderStaff({ startWith: NEW.id, users: [ACTIVE, NEW] });
    await flush();
    press(screen, 'staff-pin-screen.back');
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onResetPin).not.toHaveBeenCalled();
  });

  test('waits while the list loads instead of flashing it', async () => {
    const { screen } = renderStaff({ startWith: NEW.id, loading: true, users: [] });
    await flush();
    expect(screen.query('staff-pin-handover')).toBeNull();
    expect(screen.query(`staff-pin-target-${ACTIVE.id}`)).toBeNull();
  });
});

describe('the person page says only what the chip and buttons do not', () => {
  test('someone with no PIN is marked so, with one action and no extra sentence', () => {
    const NEW: PinTargetUser = {
      id: 'user-new',
      name: 'Maria Wenda',
      lockedOut: false,
      needsFirstPin: true,
    };
    const { screen } = renderStaff({ users: [NEW] });
    press(screen, `staff-pin-target-${NEW.id}`);
    expect(screen.query('staff-pin-person-nopin')).not.toBeNull();
    expect(screen.query('staff-pin-unlock')).toBeNull();
    const texts = textsIn(screen.get('staff-pin-person')).join(' | ');
    expect(texts).toBe(
      textsIn(screen.get('staff-pin-person-who'))
        .concat(textsIn(screen.get('staff-pin-person-nopin')))
        .join(' | '),
    );
  });

  test('a locked PIN the owner can unlock or replace gets the one line that tells them apart', () => {
    const { screen } = renderStaff();
    press(screen, `staff-pin-target-${LOCKED.id}`);
    expect(textsIn(screen.get('staff-pin-person'))).toContain(t('auth.pin.staff.lockedBody'));
  });
});
