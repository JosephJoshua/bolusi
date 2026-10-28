/**
 * Bind an `InventoryRuntime` (the parts screens' port) over a composed `ModuleRuntime`, the twin of
 * the repair adapter. The registered inventory instance comes from `@bolusi/modules`, where its stock
 * rules are wired to each use's check.
 */
import {
  bindModulePort,
  type CommandIdentity,
  type InvalidationBus,
  type ModuleRuntime,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { inventoryModule } from '@bolusi/modules';
import { INVENTORY_TABLE } from '@bolusi/modules/inventory';
import type { InventoryRuntime } from '@bolusi/modules/inventory/screens';

export interface InventoryRuntimeDeps {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly invalidation: InvalidationBus;
  readonly identity: CommandIdentity;
  /** The phone catalog search for the "fits" picker. */
  readonly searchModels?: InventoryRuntime['searchModels'];
}

export function createInventoryRuntime(deps: InventoryRuntimeDeps): InventoryRuntime {
  return {
    ...bindModulePort(inventoryModule, deps.runtime, deps.identity),
    subscribe: (listener) =>
      deps.invalidation.subscribeTables(Object.values(INVENTORY_TABLE), listener),
    searchModels: deps.searchModels,
  };
}
