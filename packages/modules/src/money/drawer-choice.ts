// Which cash drawer this device takes cash into, platform-free so the phone's and the PC's
// adapters keep it the same way (drawers.tsx draws on it). Each device remembers the drawer it was
// last set to, in its own settings, never synced.
import type { DrawerRow } from './queries.js';

/** Where a device keeps the drawer it was set to (its own settings, never synced). */
export interface DrawerChoiceStorage {
  read(): Promise<string | null>;
  write(drawer: string): Promise<void>;
}

/** The device's remembered drawer, read once and shared by every screen that asks. */
export interface DrawerChoice {
  /** The remembered drawer; null for none, undefined while it is read. */
  current(): string | null | undefined;
  subscribe(listener: () => void): () => void;
  choose(drawer: string): Promise<void>;
}

export function createDrawerChoice(storage: DrawerChoiceStorage): DrawerChoice {
  let value: string | null | undefined;
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const listener of listeners) listener();
  };
  const load = storage.read().then(
    (saved) => {
      if (value === undefined) value = saved;
      tell();
    },
    () => {
      if (value === undefined) value = null;
      tell();
    },
  );
  return {
    current: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async choose(drawer) {
      await load;
      value = drawer;
      tell();
      await storage.write(drawer);
    },
  };
}

/** A drawer kept in memory: a demo, or a device with nowhere to keep it. */
export function memoryDrawerChoice(initial: string | null = null): DrawerChoice {
  let saved = initial;
  return createDrawerChoice({
    read: () => Promise.resolve(saved),
    write: (drawer) => {
      saved = drawer;
      return Promise.resolve();
    },
  });
}

/** The drawer cash goes into here, out of the ones this person may use (`usable`, active). */
export function pickDrawer(
  drawers: readonly DrawerRow[],
  remembered: string | null | undefined,
): DrawerRow | null {
  const usable = drawers.filter((row) => row.usable && row.active);
  return usable.find((row) => row.ref === remembered) ?? usable[0] ?? null;
}
