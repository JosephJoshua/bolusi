// Choosing a part to take for a use (a servisan), on the phone and the PC: the parts that fit the
// phone being repaired come first, before anything is typed, and only spareparts are offered.
import type { QueryState } from '../screen-kit/index.js';

import type { PartUse } from './part-use.js';
import type { ItemRow } from './queries.js';
import { useInventoryQuery, type InventoryRuntime } from './runtime.js';

export type { PartUse };

/** How many parts the take step lists before the user narrows it with search. */
export const PICK_LIMIT = 30;

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
