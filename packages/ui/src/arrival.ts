/**
 * Whether this device is still bringing in the store's data for the first time (a new phone or PC
 * right after setup). Until then an empty list is not news: the rows are on their way, so lists show
 * their loading rows instead of "Belum ada …" (design guide §7). Set by the app from its sync state
 * (`setDataArriving`), read by `List` and the PC's `DataTable`. Platform-free, so both share it.
 *
 * Offline before that first sync, nothing is arriving: lists then say they are empty, and the sync
 * banner says why.
 */
import { useSyncExternalStore } from 'react';

let arriving = false;
const listeners = new Set<() => void>();

export function setDataArriving(next: boolean): void {
  if (next === arriving) return;
  arriving = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = (): boolean => arriving;

export function useDataArriving(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}
