// Renaming this phone: a blank name is never sent, a refusal (offline above all) keeps the form with
// the reason, and only the server's yes closes it.
import { StaffAdminError } from '@bolusi/core';
import { t } from '@bolusi/i18n';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { RenameDeviceScreen } from './RenameDeviceScreen.js';

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function mount(onRename: (name: string) => Promise<void>) {
  const onClose = vi.fn();
  const screen = render(
    <RenameDeviceScreen current="HP Kasir 1" onRename={onRename} onClose={onClose} />,
  );
  return {
    screen,
    onClose,
    press: (testID: string) => fire(screen.get(testID), 'onPress'),
    type: (text: string) => fire(screen.get('rename-device-name.field'), 'onChangeText', text),
  };
}

describe('RenameDeviceScreen', () => {
  test('sends the trimmed name and closes once the server took it', async () => {
    const onRename = vi.fn(() => Promise.resolve());
    const { press, type, onClose } = mount(onRename);
    type('  Kasir depan ');
    press('rename-device-save');
    await flush();
    expect(onRename).toHaveBeenCalledWith('Kasir depan');
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a blank name says so and sends nothing; the same name just closes', async () => {
    const onRename = vi.fn(() => Promise.resolve());
    const { screen, press, type, onClose } = mount(onRename);
    type('   ');
    press('rename-device-save');
    expect(textsIn(screen.get('rename-device-screen'))).toContain(
      t('auth.rename.problem.nameMissing'),
    );
    type('HP Kasir 1');
    press('rename-device-save');
    await flush();
    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('offline keeps the form open with the reason', async () => {
    const onRename = vi.fn(() => Promise.reject(new StaffAdminError('offline')));
    const { screen, press, type, onClose } = mount(onRename);
    type('Kasir depan');
    press('rename-device-save');
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(textsIn(screen.get('rename-device-failure'))).toContain(
      t('auth.rename.failure.offline'),
    );
  });
});
