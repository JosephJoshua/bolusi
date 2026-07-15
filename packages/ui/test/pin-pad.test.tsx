/**
 * PinPad (design-system §3.3, api/02-auth §6.1).
 *
 * These are the component-level ADVERSARIAL tests this surface ships before review (CLAUDE.md §2.5,
 * testing-guide T-9): never-echo, single-egress, locked-disables-every-key. The lockout ARITHMETIC
 * is not tested here because it is not here — it is owned by api/02-auth and lands with task 14
 * (SEC-AUTH-02..05). This component only renders the lock.
 */
import { describe, expect, test, vi } from 'vitest';

import { PIN_LENGTH, PinPad } from '../src/components/PinPad.js';
import { color, touch } from '../src/tokens.js';
import { a11yStringsIn, fire, isUnwired, render, textsIn } from './render.js';

const labels = { entryLabel: 'PIN', backspaceLabel: 'Hapus satu angka' };

function press(r: ReturnType<typeof render>, key: string): void {
  fire(r.get(`ui.pinpad.key.${key}`), 'onPress');
}

test('the v0 PIN is 6 digits (api/02-auth §6.1 — design-system §3.3 said 4 and was corrected)', () => {
  expect(PIN_LENGTH).toBe(6);
});

describe('auto-submit (§3.3)', () => {
  test('onComplete fires on the 6th digit with the entered value', () => {
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    for (const digit of '481902') press(r, digit);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('481902');
  });

  test('onComplete does not fire on the 5th digit', () => {
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    for (const digit of '73158') press(r, digit);
    expect(onComplete).not.toHaveBeenCalled();
  });

  test('presses after the 6th are ignored — the fire is idempotent', () => {
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    for (const digit of '602417') press(r, digit);
    press(r, '9');
    press(r, '5');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('602417');
  });

  test('a rapid double-tap on the 6th key cannot fire onComplete twice', () => {
    // Two presses landing in one React batch is a real sequence on a frame-dropping 2 GB device,
    // and a double fire would be a double auth attempt against the §3.3 lockout counter.
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    for (const digit of '31085') press(r, digit);
    const six = r.get('ui.pinpad.key.6');
    const handler = six.props['onPress'] as () => void;
    handler();
    handler();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('310856');
  });
});

describe('backspace (§3.3)', () => {
  test('backspace unfills the last dot', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of '246') press(r, digit);
    expect(r.styleOf('ui.pinpad.dot.2')['backgroundColor']).toBe(color.text);

    fire(r.get('ui.pinpad.key.backspace'), 'onPress');
    expect(r.styleOf('ui.pinpad.dot.2')['backgroundColor']).toBe(color.surfaceAlt);
    expect(r.styleOf('ui.pinpad.dot.1')['backgroundColor']).toBe(color.text);
  });

  test('backspace removes the last digit from the value that reaches onComplete', () => {
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    for (const digit of '77777') press(r, digit);
    fire(r.get('ui.pinpad.key.backspace'), 'onPress');
    for (const digit of '31') press(r, digit);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('777731');
  });

  test('backspace on an empty entry is a no-op', () => {
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    fire(r.get('ui.pinpad.key.backspace'), 'onPress');
    expect(r.styleOf('ui.pinpad.dot.0')['backgroundColor']).toBe(color.surfaceAlt);
    for (const digit of '159374') press(r, digit);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('159374');
  });
});

describe('the entered value never leaks (§3.3: digits are never echoed)', () => {
  /**
   * Digits 7/8/9 are chosen deliberately: the entry announces PROGRESS as a count (0–6) via
   * `accessibilityValue`, which is derived from the entry LENGTH and reveals nothing about which
   * keys were pressed. Picking digits outside 0–6 keeps this grep unambiguous rather than making it
   * trip over a legitimate count. The pin-independent structural claim is asserted separately below.
   */
  const PIN = '789987';

  test('no entered digit appears as text anywhere in the entry region', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of PIN) press(r, digit);
    const rendered = textsIn(r.get('ui.pinpad.entry')).join('|');
    for (const digit of new Set(PIN)) expect(rendered).not.toContain(digit);
  });

  test('no entered digit appears in any accessibility label or value in the entry region', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of PIN) press(r, digit);
    const announced = a11yStringsIn(r.get('ui.pinpad.entry')).join('|');
    for (const digit of new Set(PIN)) expect(announced).not.toContain(digit);
  });

  test('the entry region renders NO text at all — true for any PIN, not just this one', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of '123456') press(r, digit);
    expect(textsIn(r.get('ui.pinpad.entry'))).toEqual([]);
  });

  test('entry progress is announced as a count, never as the digits', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of '789') press(r, digit);
    expect(r.get('ui.pinpad.entry').props['accessibilityValue']).toEqual({
      now: 3,
      min: 0,
      max: PIN_LENGTH,
    });
  });

  test('onComplete is the only egress — the value is in no prop of the rendered tree', () => {
    const onComplete = vi.fn();
    const r = render(<PinPad onComplete={onComplete} {...labels} />);
    for (const digit of PIN) press(r, digit);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(PIN);

    // Sweep every prop of every node for the assembled value. `JSON.stringify` returns undefined
    // for functions, hence the `?? ''`.
    const leaked = r.container.queryAll((node) =>
      Object.entries(node.props).some(
        ([key, value]) => key !== 'children' && (JSON.stringify(value) ?? '').includes(PIN),
      ),
    );
    expect(leaked).toEqual([]);
  });
});

describe('error state (§3.3)', () => {
  test('error clears the entry', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of '482') press(r, digit);
    r.rerender(<PinPad onComplete={vi.fn()} state="error" message="PIN salah" {...labels} />);
    expect(r.styleOf('ui.pinpad.dot.0')['backgroundColor']).toBe(color.surfaceAlt);
  });

  test('error renders the message slot', () => {
    const r = render(<PinPad onComplete={vi.fn()} state="error" message="PIN salah" {...labels} />);
    expect(r.query('ui.pinpad.message')).not.toBeNull();
  });

  test('error tints the dots with the danger token', () => {
    const r = render(<PinPad onComplete={vi.fn()} state="error" message="PIN salah" {...labels} />);
    fire(r.get('ui.pinpad.key.5'), 'onPress');
    expect(r.styleOf('ui.pinpad.dot.0')['backgroundColor']).toBe(color.danger);
  });
});

describe('locked state (§3.3 — rendered here, owned by api/02-auth)', () => {
  const lockedProps = { state: 'locked' as const, message: 'Coba lagi dalam 30 detik' };

  test('all 11 keys announce themselves as disabled', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...lockedProps} {...labels} />);
    const keys = [...'0123456789', 'backspace'];
    expect(keys).toHaveLength(11);
    for (const key of keys) {
      expect(r.get(`ui.pinpad.key.${key}`).props['accessibilityState']).toEqual({ disabled: true });
    }
  });

  test('no key is wired while locked', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...lockedProps} {...labels} />);
    for (const key of [...'0123456789', 'backspace']) {
      expect(isUnwired(r.get(`ui.pinpad.key.${key}`))).toBe(true);
    }
  });

  test('locked renders the countdown message supplied by the caller', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...lockedProps} {...labels} />);
    expect(r.query('ui.pinpad.message')).not.toBeNull();
  });

  test('locked discards any partial entry rather than holding PIN digits through the lockout', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const digit of 'four'.length ? '4821' : '') press(r, digit);
    r.rerender(<PinPad onComplete={vi.fn()} {...lockedProps} {...labels} />);
    expect(r.styleOf('ui.pinpad.dot.0')['backgroundColor']).toBe(color.surfaceAlt);
  });
});

describe('layout (§3.3)', () => {
  test('key order is fixed: 1-9, blank, 0, backspace — memory-of-place, never shuffled', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    const order = r
      .get('ui.pinpad.keypad')
      .children.filter((child): child is Exclude<typeof child, string> => typeof child !== 'string')
      .map((child) => String(child.props['testID']).replace('ui.pinpad.', ''));

    expect(order).toEqual([
      'key.1',
      'key.2',
      'key.3',
      'key.4',
      'key.5',
      'key.6',
      'key.7',
      'key.8',
      'key.9',
      'blank',
      'key.0',
      'key.backspace',
    ]);
  });

  test('keys meet the 64 dp key target (§1.4)', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const key of [...'0123456789', 'backspace']) {
      const style = r.styleOf(`ui.pinpad.key.${key}`);
      expect(style['width']).toBeGreaterThanOrEqual(touch.key);
      expect(style['height']).toBeGreaterThanOrEqual(touch.key);
    }
  });

  test('there are exactly 6 dots', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    expect(r.all('ui.pinpad.dot.5')).toHaveLength(1);
    expect(r.query('ui.pinpad.dot.6')).toBeNull();
  });

  test('the blank cell is not a key: no role, no handler', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    const blank = r.get('ui.pinpad.blank');
    expect(blank.props['accessibilityRole']).toBeUndefined();
    expect(blank.props['onPress']).toBeUndefined();
  });

  test('every key announces a button role (§6.4)', () => {
    const r = render(<PinPad onComplete={vi.fn()} {...labels} />);
    for (const key of [...'0123456789', 'backspace']) {
      expect(r.get(`ui.pinpad.key.${key}`).props['accessibilityRole']).toBe('button');
    }
  });
});
