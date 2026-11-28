// The approval PIN screen on a phone: asking for it opens a decision session, a wrong one says so,
// none set leads into making one, and setting one sends the proof the server asks for.
import { ApprovalPinError } from '@bolusi/core';
import type { DecisionOpening } from '@bolusi/device/bootstrap/person-access';
import { initI18n } from '@bolusi/i18n';
import { act } from 'react';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { ApprovalPinScreen, type ApprovalPinPort } from './ApprovalPinScreen.js';

const PERSON = { id: 'owner-1', name: 'Yonas Wenda' };

beforeAll(() => {
  initI18n({ locale: 'id' });
});

function enterPin(screen: ReturnType<typeof render>, pad: string, pin: string): void {
  for (const digit of pin) fire(screen.get(`${pad}-pad.key.${digit}`), 'onPress');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function port(answers: readonly DecisionOpening[], set = vi.fn(() => Promise.resolve())) {
  const queue = [...answers];
  return {
    open: vi.fn((pin: string) =>
      Promise.resolve(pin === '' ? 'failed' : (queue.shift() ?? 'failed')),
    ),
    set,
  } satisfies ApprovalPinPort;
}

describe('asked by a decision', () => {
  test('a wrong PIN says so, the right one opens a session and leaves', async () => {
    const onDone = vi.fn();
    const p = port(['wrong', 'opened']);
    const screen = render(
      <ApprovalPinScreen
        mode="ask"
        person={PERSON}
        port={p}
        proofKinds={['current', 'password']}
        owners={[]}
        onDone={onDone}
      />,
    );
    enterPin(screen, 'approval-ask', '730264');
    await flush();
    expect(textsIn(screen.get('approval-ask-pad.message'))).toContain('PIN persetujuan salah.');
    expect(onDone).not.toHaveBeenCalled();
    enterPin(screen, 'approval-ask', '730265');
    await flush();
    expect(p.open.mock.calls.map((call) => call[0])).toEqual(['730264', '730265']);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  test('none set yet leads into making one with the password, which then opens a session', async () => {
    const onDone = vi.fn();
    const p = port(['notSet', 'opened']);
    const screen = render(
      <ApprovalPinScreen
        mode="ask"
        person={PERSON}
        port={p}
        proofKinds={['current', 'password']}
        owners={[]}
        onDone={onDone}
      />,
    );
    enterPin(screen, 'approval-ask', '730264');
    await flush();
    fire(screen.get('approval-ask-create'), 'onPress');
    // Their current one is no proof: straight to the password.
    fire(screen.get('approval-setup-password.field'), 'onChangeText', 'rahasia');
    fire(screen.get('approval-setup-password-next'), 'onPress');
    enterPin(screen, 'approval-setup', '418273');
    enterPin(screen, 'approval-setup', '418273');
    await flush();
    expect(p.set).toHaveBeenCalledWith('418273', { kind: 'password', password: 'rahasia' });
    expect(p.open).toHaveBeenLastCalledWith('418273');
    fire(screen.get('approval-setup-finish'), 'onPress');
    expect(onDone).toHaveBeenCalledWith(true);
  });

  test('saved but no session opened (offline) does not approve the decision', async () => {
    const onDone = vi.fn();
    const p = port(['notSet', 'offline']);
    const screen = render(
      <ApprovalPinScreen
        mode="ask"
        person={PERSON}
        port={p}
        proofKinds={['current', 'password']}
        owners={[]}
        onDone={onDone}
      />,
    );
    enterPin(screen, 'approval-ask', '730264');
    await flush();
    fire(screen.get('approval-ask-create'), 'onPress');
    fire(screen.get('approval-setup-password.field'), 'onChangeText', 'rahasia');
    fire(screen.get('approval-setup-password-next'), 'onPress');
    enterPin(screen, 'approval-setup', '418273');
    enterPin(screen, 'approval-setup', '418273');
    await flush();
    expect(p.set).toHaveBeenCalled();
    expect(textsIn(screen.get('approval-setup-done'))).toContain(
      'Keputusan tadi belum disetujui. Ulangi dengan PIN persetujuan baru.',
    );
    fire(screen.get('approval-setup-finish'), 'onPress');
    expect(onDone).toHaveBeenCalledWith(false);
  });
});

describe('from Settings', () => {
  test('on the person’s own phone there is no proof step', async () => {
    const p = port([]);
    const screen = render(
      <ApprovalPinScreen
        mode="setup"
        person={PERSON}
        port={p}
        proofKinds={[]}
        owners={[]}
        onDone={vi.fn()}
      />,
    );
    enterPin(screen, 'approval-setup', '418273');
    enterPin(screen, 'approval-setup', '418273');
    await flush();
    expect(p.set).toHaveBeenCalledWith('418273', undefined);
    expect(p.open).not.toHaveBeenCalled();
    expect(screen.query('approval-setup-done')).not.toBeNull();
  });

  test('a manager has an owner confirm it; a wrong owner PIN goes back to the owner', async () => {
    let calls = 0;
    const set = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new ApprovalPinError('wrongProof')) : Promise.resolve();
    });
    const p = port([], set);
    const screen = render(
      <ApprovalPinScreen
        mode="setup"
        person={{ id: 'mgr-1', name: 'Lina Kogoya' }}
        port={p}
        proofKinds={['owner']}
        owners={[{ userId: PERSON.id, name: PERSON.name }]}
        onDone={vi.fn()}
      />,
    );
    enterPin(screen, 'approval-setup-owner', '111999');
    enterPin(screen, 'approval-setup', '418273');
    enterPin(screen, 'approval-setup', '418273');
    await flush();
    expect(textsIn(screen.get('approval-setup-owner-pad.message'))).toContain(
      'PIN persetujuan pemilik salah.',
    );
    enterPin(screen, 'approval-setup-owner', '222888');
    enterPin(screen, 'approval-setup', '418273');
    enterPin(screen, 'approval-setup', '418273');
    await flush();
    expect(set.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { kind: 'owner', userId: 'owner-1', pin: '111999' },
      { kind: 'owner', userId: 'owner-1', pin: '222888' },
    ]);
    expect(screen.query('approval-setup-done')).not.toBeNull();
  });
});
