// A value the user is still changing, held back until they pause: a search box reads once per pause
// instead of once per key, so typing stays smooth on a cheap phone with a store's whole history.
import { useEffect, useState } from 'react';

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
