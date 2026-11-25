// A value the user is still changing, held back until they pause: a search box reads once per pause
// instead of once per key, so typing stays smooth on a cheap phone with a store's whole history.
import { useEffect, useRef, useState } from 'react';

/** Long enough to cover the gap between keys of steady typing, short enough to feel immediate. */
export const TYPING_PAUSE_MS = 200;

/** `value` once it has stopped changing for `delayMs`; the first render returns it at once. */
export function useSettledValue<T>(value: T, delayMs: number = TYPING_PAUSE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** How long a footer action that just took another's place ignores taps: one double tap's gap. */
export const FRESH_ACTION_MS = 600;

/**
 * True for `delayMs` after `action` takes the place of another one, as when "Pesan" becomes
 * "Terima barang" in the same spot: the second tap of a double tap then lands on nothing instead of
 * starting the next step. Appearing (from null) does not count, so a screen opening is not held.
 */
export function useJustReplaced<T>(action: T | null, delayMs: number = FRESH_ACTION_MS): boolean {
  const last = useRef(action);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const previous = last.current;
    last.current = action;
    if (previous === action) return undefined;
    if (previous === null || action === null) {
      setHeld(false);
      return undefined;
    }
    setHeld(true);
    const timer = setTimeout(() => setHeld(false), delayMs);
    return () => clearTimeout(timer);
  }, [action, delayMs]);
  return held;
}
