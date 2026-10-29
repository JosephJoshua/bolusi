/**
 * What a colleague just changed, so a screen can let it glow once: a row on the board, the open
 * servisan. Fed by the app from changes that came from another device (`markFresh`); read per row
 * with `useFresh`. Platform-free, so the phone and the PC share it.
 *
 * Calm by design: only what changes while it is on screen glows (a row that mounts after the
 * change does not), and a burst, such as a new phone's first sync or coming back online after
 * hours, marks nothing.
 */
import { useRef, useSyncExternalStore } from 'react';

/** How long a glow lasts, and so how long a mark counts. */
export const FRESH_MS = 1_000;
/** More changes than this inside `FRESH_MS` is a catch-up, not a colleague at work. */
const BURST = 12;

const marks = new Map<string, number>();
const recent: number[] = [];
let quietUntil = 0;
const listeners = new Set<() => void>();

/** Note that another device changed the record `id` at `now`. */
export function markFresh(id: string, now = Date.now()): void {
  while (recent.length > 0 && recent[0]! <= now - FRESH_MS) recent.shift();
  recent.push(now);
  if (recent.length > BURST) {
    quietUntil = now + FRESH_MS;
    marks.clear();
  }
  if (now < quietUntil) return;
  for (const [key, at] of marks) if (at <= now - FRESH_MS) marks.delete(key);
  marks.set(id, now);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * When `id` was last changed by another device while this component was on screen, or 0. A new
 * value is the cue to glow; use it as a key.
 */
export function useFresh(id: string): number {
  const mountedAt = useRef(Date.now()).current;
  const at = useSyncExternalStore(subscribe, () => marks.get(id) ?? 0);
  return at > mountedAt ? at : 0;
}

/** Forget every mark and burst: for tests. */
export function resetFresh(): void {
  marks.clear();
  recent.length = 0;
  quietUntil = 0;
}
