/**
 * Lets a gesture inside a scrolling AppShell stop the page from scrolling while it runs: dragging a
 * row to reorder it must move the row, not the page (on Android the native ScrollView would otherwise
 * take the touch over mid-drag). `lock()` returns its own release; locks nest.
 */
import { createContext, useContext } from 'react';

export interface ScrollLock {
  lock(): () => void;
}

const NO_SCROLL: ScrollLock = { lock: () => () => undefined };

export const ScrollLockContext = createContext<ScrollLock>(NO_SCROLL);

export function useScrollLock(): ScrollLock {
  return useContext(ScrollLockContext);
}
