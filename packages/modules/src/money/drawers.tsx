// Which cash drawer this device takes cash into, the same on the phone and the PC. A store may keep
// several drawers ("Laci servis", "Laci aksesoris"), each used by some roles (rules.ts
// `drawerOpenTo`). Each device remembers the drawer it was last set to, so a shared counter PC stays
// on its drawer for whoever signs in, and the person switches it on Kas. Someone who may not use
// the remembered drawer gets the first one they may use.
import { useSyncExternalStore } from 'react';

import type { QueryState } from '../screen-kit/index.js';

import { CASH_ACCOUNT } from './constants.js';
import { pickDrawer, type DrawerChoice } from './drawer-choice.js';
import { tm } from './i18n.js';
import type { DrawerRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime } from './runtime.js';

/** How a drawer reads: its name, the main drawer "Laci utama" until an owner names it. */
export function drawerLabel(drawer: Pick<DrawerRow, 'name' | 'main'>): string {
  return drawer.name ?? (drawer.main ? tm('money.drawer.main') : '');
}

export interface CashDrawer {
  /** The drawers this person may use, the main one first. */
  readonly drawers: readonly DrawerRow[];
  /** The one this device takes cash into; null while loading, or for someone who uses none. */
  readonly current: DrawerRow | null;
  /** How records name it: `cash` until the drawers load. */
  readonly ref: string;
  /** More than one to pick from: only then does a screen show which. */
  readonly several: boolean;
  readonly choose: (drawer: string) => void;
}

/** The device's drawer, from the store's drawers as one module's live read has them. */
export function useCashDrawerOf(
  choice: DrawerChoice,
  drawers: QueryState<readonly DrawerRow[]>,
): CashDrawer {
  const remembered = useSyncExternalStore(choice.subscribe, choice.current, choice.current);
  const rows = drawers.status === 'ready' ? drawers.data : [];
  const usable = rows.filter((row) => row.usable && row.active);
  const current = pickDrawer(rows, remembered);
  return {
    drawers: usable,
    current,
    ref: current?.ref ?? CASH_ACCOUNT,
    several: usable.length > 1,
    choose: (drawer) => void choice.choose(drawer),
  };
}

/** The device's drawer, on a Kas screen. */
export function useCashDrawer(): CashDrawer {
  const runtime = useMoneyRuntime();
  const drawers = useMoneyQuery(async (rt) => (await rt.query('drawers', {})).rows, 'drawers');
  return useCashDrawerOf(runtime.drawerChoice, drawers);
}

const NO_DRAWERS: readonly DrawerRow[] = [];

/** Every drawer of the store, switched off ones too, for naming records; none while they load. */
export function useStoreDrawers(): readonly DrawerRow[] {
  const drawers = useMoneyQuery(
    async (rt) => (await rt.query('drawers', { includeInactive: true })).rows,
    'drawers:all',
  );
  return drawers.status === 'ready' ? drawers.data : NO_DRAWERS;
}
