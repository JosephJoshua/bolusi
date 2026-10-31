// The purchasing screens' runtime port (04 §7), as inventory's: screens read and write through the
// module's commands and queries, which the platform binds over the composed runtime. Picking the
// parts to order reads the parts list through the inventory runtime, provided beside this one.
import type { ReactNode } from 'react';

import type { ModulePort } from '@bolusi/core';

import type { PurchasingModule } from './manifest.js';
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

/** The store's name for the order message; null while it loads or when it has none. */
export function useOrderStoreName(): string | null {
  const name = usePurchasingQuery(async (rt) => (await rt.storeName?.()) ?? null, 'storeName');
  return name.status === 'ready' ? name.data : null;
}
