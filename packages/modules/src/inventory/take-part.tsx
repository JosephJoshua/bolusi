// Parts on a use (a servisan), on the phone and the PC alike: what it has out, choosing a part to
// take (the parts that fit the phone being repaired come first, before anything is typed, and only
// spareparts are offered) and putting one back. Each app only draws these.
import { useState } from 'react';

import {
  useActionRunner,
  useSettledValue,
  type ActionRunner,
  type QueryState,
} from '../screen-kit/index.js';

import { INVENTORY_PERMISSION } from './constants.js';
import { ti } from './i18n.js';
import type { PartUse } from './part-use.js';
import type { ItemRow, PartsForUseRow, UseCostRow, UsedPartRow } from './queries.js';
import { useInventoryQuery, useInventoryRuntime, type InventoryRuntime } from './runtime.js';

export type { PartUse };

/** How many parts the take step lists before the user narrows it with search. */
export const PICK_LIMIT = 30;

/** Said under the list when it shows as many as it lists: the rest are a search away. */
export function moreHint(choices: TakeChoices): string | null {
  return choices.rest.length >= PICK_LIMIT ? ti('inventory.use.searchMore') : null;
}

/**
 * Said under the quantity when it is more than the stock records. Taking it is still allowed (the
 * count can be wrong, and the owner sees stock below zero flagged), but a typo is caught here.
 */
export function overStockHint(part: Pick<ItemRow, 'onHand'>, qty: number): string | null {
  const extra = qty - Math.max(part.onHand, 0);
  return extra > 0 ? ti('inventory.use.overStock', { extra }) : null;
}

export interface TakeChoices {
  /** Parts that fit the phone, when nothing is typed. */
  readonly fitting: readonly ItemRow[];
  readonly rest: readonly ItemRow[];
}

export function useTakeChoices(
  searchText: string,
  device: { readonly brand: string; readonly model: string } | undefined,
  reloadNonce: number,
): QueryState<TakeChoices> {
  const fitsDevice = searchText === '' && device !== undefined && device.model.trim() !== '';
  return useInventoryQuery(
    async (rt) => {
      const all = (
        await rt.query('listItems', {
          text: searchText,
          filter: 'active',
          partsOnly: true,
          limit: PICK_LIMIT,
        })
      ).rows;
      if (!fitsDevice) return { fitting: [], rest: all };
      const fitting = (await rt.query('itemsFitting', { brand: device.brand, model: device.model }))
        .rows;
      const ids = new Set(fitting.map((row) => row.id));
      return { fitting, rest: all.filter((row) => !ids.has(row.id)) };
    },
    `take:${searchText}:${fitsDevice ? `${device.brand}\u0000${device.model}` : ''}:${String(reloadNonce)}`,
  );
}

/**
 * The part a scanned or typed code names, when it names exactly one sparepart still on the list:
 * only those can be taken, as when picked by hand. Null otherwise.
 */
export async function partForCode(
  runtime: Pick<InventoryRuntime, 'query'>,
  code: string,
): Promise<ItemRow | null> {
  const [found, parts] = await Promise.all([
    runtime.query('findByCode', { code }).then((page) => page.rows),
    runtime.query('listItems', { text: code, partsOnly: true, limit: 20 }).then((p) => p.rows),
  ]).catch(() => [[], []] as const);
  const only = found.length === 1 ? found[0] : undefined;
  const part = parts.find((row) => row.id === only?.id);
  return part !== undefined && !part.archived ? part : null;
}

/** The parts a use still has out. `hidden` once there are none and none may be taken. */
export function useUsedParts(
  use: PartUse,
  takeable: boolean,
): {
  readonly query: QueryState<PartsForUseRow | undefined>;
  readonly parts: readonly UsedPartRow[];
  readonly hidden: boolean;
  readonly retry: () => void;
} {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useInventoryQuery(
    async (rt) => (await rt.query('partsForUse', { useKind: use.kind, useId: use.id })).rows[0],
    `used:${use.kind}:${use.id}:${String(reloadNonce)}`,
  );
  // A put-back to zero leaves the part's history, not a row reading "0 diambil".
  const parts = query.status === 'ready' ? (query.data?.parts ?? []).filter((p) => p.out > 0) : [];
  return {
    query,
    parts,
    hidden: query.status === 'ready' && parts.length === 0 && !takeable,
    retry: () => setReloadNonce((n) => n + 1),
  };
}

/**
 * What the parts on a use cost the store, for people who may see buy prices: read apart from the
 * parts, so a store device holding no costs still shows the parts. `shown` is false for everyone
 * else. `total` adds the priced parts; `unpriced` counts the rest.
 */
export function useUseCost(use: PartUse): {
  readonly shown: boolean;
  readonly query: QueryState<readonly UseCostRow[]>;
  readonly total: number;
  readonly unpriced: number;
  readonly retry: () => void;
} {
  const runtime = useInventoryRuntime();
  const [reloadNonce, setReloadNonce] = useState(0);
  const shown = runtime.hasPermission(INVENTORY_PERMISSION.readCost);
  const query = useInventoryQuery(
    async (rt) =>
      shown ? (await rt.query('useCost', { useKind: use.kind, useId: use.id })).rows : [],
    `useCost:${use.kind}:${use.id}:${String(shown)}:${String(reloadNonce)}`,
  );
  const rows = query.status === 'ready' ? query.data : [];
  return {
    shown,
    query,
    total: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
    unpriced: rows.filter((row) => row.cost === null).length,
    retry: () => setReloadNonce((n) => n + 1),
  };
}

/** Pick a part, say how many, take it. Stock may go below zero; the owner sees it flagged. */
export function useTakePart(
  use: PartUse,
  device: { readonly brand: string; readonly model: string } | undefined,
  onDone: () => void,
): {
  readonly text: string;
  readonly setText: (text: string) => void;
  /** What the list is searched for: nothing while the box is empty, else the settled text. */
  readonly searchText: string;
  readonly query: QueryState<TakeChoices>;
  readonly retry: () => void;
  readonly picked: ItemRow | null;
  readonly pick: (row: ItemRow) => void;
  readonly qty: number;
  readonly setQty: (qty: number) => void;
  /** A scanned or typed code picks its part when it names exactly one. */
  readonly pickCode: (code: string) => Promise<void>;
  readonly take: () => void;
  readonly runner: ActionRunner;
} {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<ItemRow | null>(null);
  const [qty, setQty] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const query = useTakeChoices(searchText, device, reloadNonce);
  const pick = (row: ItemRow): void => {
    setPicked(row);
    setQty(1);
  };
  return {
    text,
    setText,
    searchText,
    query,
    retry: () => setReloadNonce((n) => n + 1),
    picked,
    pick,
    qty,
    setQty,
    pickCode: async (code) => {
      const part = await partForCode(runtime, code);
      if (part !== null) pick(part);
    },
    take: () => {
      if (picked === null) return;
      void runner
        .run(() => runtime.run('takePart', { itemId: picked.id, qty, use }))
        .then((result) => {
          if (result !== undefined) onDone();
        });
    },
    runner,
  };
}

/** Put unused parts back on the shelf: at most what this use took. */
export function usePutBack(
  use: PartUse,
  part: UsedPartRow,
  onDone: () => void,
): {
  readonly qty: number;
  readonly setQty: (qty: number) => void;
  readonly putBack: () => void;
  readonly runner: ActionRunner;
} {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [qty, setQty] = useState(1);
  return {
    qty,
    setQty,
    putBack: () => {
      void runner
        .run(() => runtime.run('putBackPart', { itemId: part.itemId, qty, use }))
        .then((result) => {
          if (result !== undefined) onDone();
        });
    },
    runner,
  };
}
