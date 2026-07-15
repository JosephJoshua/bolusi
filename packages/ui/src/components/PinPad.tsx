/**
 * PinPad (design-system §3.3). The system keyboard is NEVER used for PINs.
 *
 * The v0 PIN is **6 digits, fixed** — `api/02-auth.md` §6.1 is the authority. (design-system §3.3
 * previously said 4; it was corrected. If you see 4 anywhere, that doc is stale, not this file.)
 *
 * WHAT THIS COMPONENT DOES NOT DO — and must never start doing:
 *   - No verification. It does not know, hash, or compare a PIN.
 *   - No lockout arithmetic. §3.3: "Lockout logic is owned by api/02-auth; PinPad only renders it."
 *     The `locked` state and its countdown message arrive as props (wired in task 14). Attempt
 *     counting living in a component would put a security control in the most re-mountable,
 *     most-forkable layer in the app.
 *
 * THE ENTERED VALUE HAS EXACTLY ONE EGRESS: the `onComplete` callback. It is never rendered as
 * text, never placed in an accessibility label, and never handed to any other prop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, Vibration } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

/** Fixed by api/02-auth §6.1. Not configurable: a per-caller PIN length is an auth decision. */
export const PIN_LENGTH = 6;

/** §3.3 key order — 1–9, blank, 0, backspace. FIXED: no shuffling. */
const KEYPAD: readonly (string | 'blank' | 'backspace')[] = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'blank',
  '0',
  'backspace',
];

export type PinPadState = 'entry' | 'error' | 'locked';

export interface PinPadProps {
  /** The ONLY egress of the entered value. Fires once, on the 6th digit (§3.3 auto-submit). */
  readonly onComplete: (pin: string) => void;
  readonly state?: PinPadState | undefined;
  /**
   * Already-localized. In `error`, the failure message; in `locked`, the countdown from the label
   * catalog (§3.3). Both are computed by the caller — this component never formats time.
   */
  readonly message?: string | undefined;
  /** Already-localized accessibility label for the entry dots region. */
  readonly entryLabel: string;
  /** Already-localized accessibility label for the backspace key. */
  readonly backspaceLabel: string;
  readonly testID?: string | undefined;
}

/**
 * Key order is memory-of-place for tech-inadept users (§3.3): the layout never shuffles, so the
 * grid is a plain wrapped row of fixed-size cells and position is structural, not computed.
 */
const KEYPAD_WIDTH = touch.key * 3 + touch.gap * 2;

const styles = StyleSheet.create({
  root: { alignItems: 'center' },
  entry: {
    flexDirection: 'row',
    justifyContent: 'center',
    minHeight: touch.min,
    alignItems: 'center',
  },
  dot: {
    width: size.pinDot,
    height: size.pinDot,
    borderRadius: radius.full,
    marginHorizontal: space.sm,
  },
  message: {
    ...type.bodySm,
    textAlign: 'center',
    marginBottom: space.md,
    paddingHorizontal: space.lg,
  },
  keypad: {
    width: KEYPAD_WIDTH,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  key: {
    width: touch.key,
    height: touch.key,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: touch.gap,
    borderRadius: radius.full,
  },
  keyLabel: { ...type.title, color: color.text },
  keyLabelDisabled: { ...type.title, color: color.textDisabled },
});

export function PinPad({
  onComplete,
  state = 'entry',
  message,
  entryLabel,
  backspaceLabel,
  testID = 'ui.pinpad',
}: PinPadProps): React.JSX.Element {
  const [entry, setEntry] = useState('');
  /**
   * The ref — not the state — is the handler's source of truth. React batches state updates, so two
   * taps landing in one batch would both read a stale `entry` and could fire `onComplete` twice or
   * overrun 6 digits. On a 2 GB device (§0) dropped frames make that a real sequence, not a
   * theoretical one, and a double-fired PIN submit is a double auth attempt against the §3.3
   * lockout counter.
   */
  const entryRef = useRef('');

  const setEntryValue = useCallback((next: string) => {
    entryRef.current = next;
    setEntry(next);
  }, []);

  const locked = state === 'locked';

  useEffect(() => {
    // §3.3: the error state clears the entry. `locked` clears it too — holding a partial PIN in
    // memory through a lockout window buys nothing and is one more place for it to leak.
    if (state === 'error' || state === 'locked') {
      entryRef.current = '';
      setEntry('');
    }
    if (state === 'error') {
      // §3.3 error feedback. Vibration, not haptics: no new dependency (§0 dependency weight).
      Vibration.vibrate();
    }
  }, [state]);

  const pressDigit = useCallback(
    (digit: string) => {
      if (locked) return;
      // Ignore everything past the 6th digit until the caller resets us. This is what makes
      // auto-submit idempotent: onComplete fires on the transition to 6, and only then.
      if (entryRef.current.length >= PIN_LENGTH) return;
      const next = entryRef.current + digit;
      setEntryValue(next);
      if (next.length === PIN_LENGTH) onComplete(next);
    },
    [locked, onComplete, setEntryValue],
  );

  const pressBackspace = useCallback(() => {
    if (locked) return;
    if (entryRef.current.length === 0) return; // no-op on empty entry
    setEntryValue(entryRef.current.slice(0, -1));
  }, [locked, setEntryValue]);

  const dotColor = state === 'error' ? color.danger : color.text;

  return (
    <View testID={testID} style={styles.root}>
      <View
        testID={`${testID}.entry`}
        // Progress is announced as a COUNT, never as digits: `now` is `entry.length`, which is
        // derived from how many keys were pressed and reveals nothing about which.
        accessibilityLabel={entryLabel}
        accessibilityValue={{ now: entry.length, min: 0, max: PIN_LENGTH }}
        style={styles.entry}
      >
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <View
            key={index}
            testID={`${testID}.dot.${index}`}
            style={[
              styles.dot,
              index < entry.length
                ? { backgroundColor: dotColor }
                : {
                    backgroundColor: color.surfaceAlt,
                    borderWidth: border.hairline,
                    borderColor: color.border,
                  },
            ]}
          />
        ))}
      </View>

      {message === undefined ? null : (
        <Text
          testID={`${testID}.message`}
          style={[styles.message, { color: state === 'error' ? color.danger : color.textMuted }]}
        >
          {message}
        </Text>
      )}

      <View testID={`${testID}.keypad`} style={styles.keypad}>
        {KEYPAD.map((cell) => {
          if (cell === 'blank') {
            // Not a key: no role, no handler, nothing to announce. It exists to hold the grid slot.
            return <View key="blank" testID={`${testID}.blank`} style={styles.key} />;
          }

          const isBackspace = cell === 'backspace';
          return (
            <Pressable
              key={cell}
              testID={`${testID}.key.${cell}`}
              accessibilityRole="button"
              accessibilityLabel={isBackspace ? backspaceLabel : cell}
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              onPress={locked ? undefined : isBackspace ? pressBackspace : () => pressDigit(cell)}
              android_ripple={{ color: color.surfaceAlt, borderless: true }}
              style={({ pressed }) => [
                styles.key,
                { backgroundColor: pressed && !locked ? color.surfaceAlt : color.surface },
              ]}
            >
              {isBackspace ? (
                <Icon
                  name="backspace"
                  size={size.iconInline}
                  color={locked ? color.textDisabled : color.text}
                />
              ) : (
                <Text style={locked ? styles.keyLabelDisabled : styles.keyLabel}>{cell}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
