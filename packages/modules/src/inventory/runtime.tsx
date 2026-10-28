// The inventory screens' runtime port (04 §7), as repair's: screens read and write through the
// module's commands and queries, which the platform binds over the composed runtime.
import type { ReactNode } from 'react';

import type { ModulePort } from '@bolusi/core';

import type { InventoryModule } from './manifest.js';
import {
  createRuntimeContext,
  useLiveQuery,
  type LiveSource,
  type QueryState,
} from '../screen-kit/index.js';

/** A phone model from the phone catalog, offered when choosing what a part fits. */
export interface PhoneModelOption {
  readonly key: string;
  readonly brand: string;
  readonly model: string;
  /** Already-localized: "Samsung · 2024". */
  readonly caption: string;
}

export type InventoryRuntime = ModulePort<InventoryModule> &
  LiveSource & {
    /**
     * Search the phone catalog (repair's, the same as at intake). Absent where no catalog is
     * reachable; the screens then take typed models only.
     */
    readonly searchModels?:
      ((text: string, limit: number) => Promise<readonly PhoneModelOption[]>) | undefined;
  };

const InventoryRuntimeContext = createRuntimeContext<InventoryRuntime>('inventory');

export function InventoryRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: InventoryRuntime;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <InventoryRuntimeContext.Provider runtime={runtime}>
      {children}
    </InventoryRuntimeContext.Provider>
  );
}

export const useInventoryRuntime = InventoryRuntimeContext.useRuntime;

/** An inventory read kept live across local and pulled changes (04 §7). */
export function useInventoryQuery<TData>(
  run: (runtime: InventoryRuntime) => Promise<TData>,
  key: string,
): QueryState<TData> {
  return useLiveQuery(useInventoryRuntime(), run, key);
}
