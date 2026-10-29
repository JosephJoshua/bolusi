// First PIN (api/02-auth §6.6): make a PIN, repeat it, and the person is signed in with it. Mounts the
// real screen so the wire from a matched repeat to `onSetFirstPin` and then `onSignIn` is observed,
// and so a refused save can never sign anyone in.
import { DomainError } from '@bolusi/core';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render } from '../../../../../packages/ui/test/render.js';

import { PinSetupScreen } from './PinSetupScreen.js';

const PAD = 'pin-setup-pad';

function enterPin(screen: ReturnType<typeof render>, pin: string): void {
  for (const digit of pin) fire(screen.get(`${PAD}.key.${digit}`), 'onPress');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderSetup(onSetFirstPin: (userId: string, pin: string) => Promise<void>) {
  const onSignIn = vi.fn();
  const screen = render(
    <PinSetupScreen
      userId="user-new"
      userName="Maria Wenda"
      roleKeys={['staff']}
      onSetFirstPin={onSetFirstPin}
      onSignIn={onSignIn}
      onBack={vi.fn()}
      syncChip="synced"
      pendingCount={0}
      onOpenSync={vi.fn()}
    />,
  );
  return { screen, onSignIn };
}

describe('PinSetupScreen stores the first PIN and signs in with it', () => {
  test('a matching repeat stores the PIN for THIS user, then signs in with the same PIN', async () => {
    const onSetFirstPin = vi.fn(() => Promise.resolve());
    const { screen, onSignIn } = renderSetup(onSetFirstPin);

    enterPin(screen, '482913');
    enterPin(screen, '482913');
    await flush();

    expect(onSetFirstPin).toHaveBeenCalledExactlyOnceWith('user-new', '482913');
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith('482913');
  });

  test('easy PINs twice in a row each clear the pad, and a good one still goes through', async () => {
    const onSetFirstPin = vi.fn(() => Promise.resolve());
    const { screen } = renderSetup(onSetFirstPin);

    enterPin(screen, '111111');
    enterPin(screen, '123456');
    enterPin(screen, '482913');
    enterPin(screen, '482913');
    await flush();

    expect(onSetFirstPin).toHaveBeenCalledExactlyOnceWith('user-new', '482913');
  });

  test('a repeat that does not match stores nothing and starts over', async () => {
    const onSetFirstPin = vi.fn(() => Promise.resolve());
    const { screen, onSignIn } = renderSetup(onSetFirstPin);

    enterPin(screen, '482913');
    enterPin(screen, '111111');
    await flush();

    expect(onSetFirstPin).not.toHaveBeenCalled();
    expect(onSignIn).not.toHaveBeenCalled();
    // The pad is back for a fresh first entry.
    expect(screen.query(PAD)).not.toBeNull();
  });

  test('a refused save (the user already has a PIN) never signs in', async () => {
    const onSetFirstPin = vi.fn(() =>
      Promise.reject(new DomainError('INVALID_TRANSITION', { reason: 'pin_already_set' })),
    );
    const { screen, onSignIn } = renderSetup(onSetFirstPin);

    enterPin(screen, '482913');
    enterPin(screen, '482913');
    await flush();

    expect(onSetFirstPin).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
    expect(screen.query(PAD)).not.toBeNull();
  });
});

test('a re-render while the PIN is saving does not save it a second time', async () => {
  // The parent hands fresh callback arrows on every render (a sync tick, a connectivity change).
  let resolveSave: () => void = () => undefined;
  const onSetFirstPin = vi.fn<(userId: string, pin: string) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const onSignIn = vi.fn();
  const props = (
    save: (userId: string, pin: string) => Promise<void>,
    signIn: (pin: string) => void,
  ) => (
    <PinSetupScreen
      userId="user-new"
      userName="Maria Wenda"
      onSetFirstPin={save}
      onSignIn={signIn}
      onBack={vi.fn()}
      syncChip="synced"
      pendingCount={0}
      onOpenSync={vi.fn()}
    />
  );
  const screen = render(props(onSetFirstPin, onSignIn));
  enterPin(screen, '482913');
  enterPin(screen, '482913');
  await flush();
  expect(onSetFirstPin).toHaveBeenCalledTimes(1);

  // Fresh arrows that forward to the same spies, as an inline `(id, pin) => …` would.
  screen.rerender(
    props(
      vi.fn((id: string, pin: string) => onSetFirstPin(id, pin)),
      vi.fn((pin: string) => onSignIn(pin)),
    ),
  );
  await flush();
  expect(onSetFirstPin).toHaveBeenCalledTimes(1);

  resolveSave();
  await flush();
  expect(onSignIn).toHaveBeenCalledExactlyOnceWith('482913');
});
