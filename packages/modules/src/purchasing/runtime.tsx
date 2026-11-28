// The purchasing screens' runtime port (04 §7), as inventory's: screens read and write through the
// module's commands and queries, which the platform binds over the composed runtime. Picking the
// parts to order reads the parts list through the inventory runtime, provided beside this one.
import type { ReactNode } from 'react';

import type { ModulePort } from '@bolusi/core';

import type { PurchasingModule } from './manifest.js';
import type { BillListFilter, BillRow } from './bills/queries.js';
import type { OrderFilter, OrderRow } from './queries.js';
import {
  createRuntimeContext,
  useLiveQuery,
  type LiveSource,
  type QueryState,
} from '../screen-kit/index.js';

export type PurchasingRuntime = ModulePort<PurchasingModule> &
  LiveSource & {
    /** How the store signs its orders to suppliers (the slips' name); null when it has none. */
    readonly storeName?: (() => Promise<string | null>) | undefined;
  };

const PurchasingRuntimeContext = createRuntimeContext<PurchasingRuntime>('purchasing');

export function PurchasingRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: PurchasingRuntime;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <PurchasingRuntimeContext.Provider runtime={runtime}>
      {children}
    </PurchasingRuntimeContext.Provider>
  );
}

export const usePurchasingRuntime = PurchasingRuntimeContext.useRuntime;

/** A purchasing read kept live across local and pulled changes (04 §7). */
export function usePurchasingQuery<TData>(
  run: (runtime: PurchasingRuntime) => Promise<TData>,
  key: string,
): QueryState<TData> {
  return useLiveQuery(usePurchasingRuntime(), run, key);
}

/**
 * The first `pages` pages of a list, re-read whole on each refresh so a live list stays complete.
 * One page at a time, as each query caps its page size.
 */
async function loadPages<TRow>(
  read: (
    offset: number,
  ) => Promise<{ readonly rows: readonly TRow[]; readonly nextCursor: string | null }>,
  pages: number,
): Promise<{ readonly rows: readonly TRow[]; readonly hasMore: boolean }> {
  let rows: TRow[] = [];
  let next: string | null = '0';
  for (let n = 0; n < pages && next !== null; n += 1) {
    const page: { readonly rows: readonly TRow[]; readonly nextCursor: string | null } = await read(
      Number(next),
    );
    rows = [...rows, ...page.rows];
    next = page.nextCursor;
  }
  return { rows, hasMore: next !== null };
}

/** The first `pages` pages of orders. */
export const loadOrderPages = (
  rt: PurchasingRuntime,
  filter: OrderFilter,
  pages: number,
  pageSize: number,
): Promise<{ readonly rows: readonly OrderRow[]; readonly hasMore: boolean }> =>
  loadPages((offset) => rt.query('listOrders', { filter, limit: pageSize, offset }), pages);

/**
 * The first `pages` pages of the store's bills in one of the list's views: still owed or overdue
 * (the soonest due first), or every bill with the void ones (the newest first).
 */
export const loadBillPages = (
  rt: PurchasingRuntime,
  filter: BillListFilter,
  today: number,
  pages: number,
  pageSize: number,
): Promise<{ readonly rows: readonly BillRow[]; readonly hasMore: boolean }> =>
  loadPages(
    (offset) => rt.query('listBills', { filter, today, orderId: null, limit: pageSize, offset }),
    pages,
  );

/** The store's name for the order message; null while it loads or when it has none. */
export function useOrderStoreName(): string | null {
  const name = usePurchasingQuery(async (rt) => (await rt.storeName?.()) ?? null, 'storeName');
  return name.status === 'ready' ? name.data : null;
}
