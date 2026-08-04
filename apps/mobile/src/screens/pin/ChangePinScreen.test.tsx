// Render-boundary test for ChangePinScreen (task 138 item 1; the third layer of task 60/69's finding).
//
// WHY THIS FILE EXISTS. `change-pin.model.test.ts` proves `changePinReducer` returns `current` on a
// failed settle and `changePinFailure` maps each DomainError — in ISOLATION. It cannot see whether
// the SCREEN performs that composition: nothing there mounts `ChangePinScreen`. The screen wires the
// submit effect with `onChangePin(...).then(ok, err => dispatch(settled, changePinFailure(err)))`;
// replace `changePinFailure(err)` with `{ ok: true }` and a REJECTED change (wrong current PIN,
// PIN_LOCKED) renders the success panel — the exact false-success the screen's docstring says the
// wire prevents — while all 77 model/unit tests stay green and the harness (resolving stubs only)
// stays green. This file mounts the real screen and drives the reject path, so that mutation reds.
//
// FALSIFIED (§2.11 / T-14): mapping the reject to `{ ok: true }` at ChangePinScreen.tsx turns the
// "a rejected change shows failure, not success" test RED while model.test.ts stays green. The
// resolve positive control (T-14b) proves the green comes from the wire, not from a screen that can
// never reach `done`.
import { DomainError } from '@bolusi/core';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render } from '../../../../../packages/ui/test/render.js';

import { ChangePinScreen } from './ChangePinScreen.js';

const PAD = 'change-pin-pad';

/** Press each digit of `pin` on the pad; the 6th press fires the pad's `onComplete`. */
function enterPin(screen: ReturnType<typeof render>, pin: string): void {
  for (const digit of pin) fire(screen.get(`${PAD}.key.${digit}`), 'onPress');
}

/** Flush the submit effect's settled promise + the dispatch it schedules. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Walk current → new → repeat with a matching new PIN, reaching the submit effect. */
function submitChange(screen: ReturnType<typeof render>): void {
  enterPin(screen, '111111'); // current
  enterPin(screen, '222222'); // new
  enterPin(screen, '222222'); // repeat (matches) → submitting → effect fires onChangePin
}

describe('ChangePinScreen wires the flow reject through — a rejected change is never a success', () => {
  test('onChangePin REJECTS (wrong current PIN) → the success panel is NOT shown; the pad returns', async () => {
    const onChangePin = vi.fn(() =>
      Promise.reject(new DomainError('NOT_AUTHENTICATED', { reason: 'current_pin_incorrect' })),
    );
    const screen = render(<ChangePinScreen onChangePin={onChangePin} onClose={vi.fn()} />);

    submitChange(screen);
    await flush();

    expect(onChangePin).toHaveBeenCalledWith('111111', '222222');
    // The line that reds if the reject is mapped to `{ ok: true }`: a rejected change must NOT render
    // the done panel, and the pad must come back for another attempt.
    expect(screen.query('change-pin-done')).toBeNull();
    expect(screen.query(PAD)).not.toBeNull();
  });

  test('a PIN_LOCKED reject also stays off the success panel', async () => {
    const onChangePin = vi.fn(() => Promise.reject(new DomainError('PIN_LOCKED')));
    const screen = render(<ChangePinScreen onChangePin={onChangePin} onClose={vi.fn()} />);

    submitChange(screen);
    await flush();

    expect(screen.query('change-pin-done')).toBeNull();
  });

  test('POSITIVE CONTROL: onChangePin RESOLVES → the success panel IS shown and the pad is gone', async () => {
    // Without this, the reject tests above would pass on a screen that can never reach `done`.
    const onChangePin = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    const screen = render(<ChangePinScreen onChangePin={onChangePin} onClose={onClose} />);

    submitChange(screen);
    await flush();

    expect(screen.query('change-pin-done')).not.toBeNull();
    expect(screen.query(PAD)).toBeNull();
    // And the success panel's action closes the screen.
    fire(screen.get('change-pin-done-action'), 'onPress');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
