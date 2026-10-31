/**
 * Bind a `PurchasingRuntime` (the "Belanja" screens' port) over a composed `ModuleRuntime`, the
 * twin of the inventory adapter. Orders re-read when stock moves too, since a receipt adds both.
 */
import {
  bindModulePort,
  type CommandIdentity,
  type InvalidationBus,
  type ModuleRuntime,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { purchasingModule } from '@bolusi/modules';
import { INVENTORY_TABLE } from '@bolusi/modules/inventory';
import { PURCHASING_TABLE } from '@bolusi/modules/purchasing';
import type { PurchasingRuntime } from '@bolusi/modules/purchasing/screens';

export interface PurchasingRuntimeDeps {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly invalidation: InvalidationBus;
  readonly identity: CommandIdentity;
  /** How the store signs its orders (the slips' name). */
  readonly storeName?: PurchasingRuntime['storeName'];
}

export function createPurchasingRuntime(deps: PurchasingRuntimeDeps): PurchasingRuntime {
  return {
    ...bindModulePort(purchasingModule, deps.runtime, deps.identity),
    subscribe: (listener) =>
      deps.invalidation.subscribeTables(
        // Orders show part names, which a rename changes; receiving is in the purchasing tables.
        [...Object.values(PURCHASING_TABLE), INVENTORY_TABLE.items],
        listener,
      ),
    storeName: deps.storeName,
  };
}
