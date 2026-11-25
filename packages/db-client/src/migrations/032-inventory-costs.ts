// Client migration 32 — what received stock cost to buy (inventory module, part costs).
//
// Mirrors server migration 0034. Its own table, read only with `inventory.read_cost`: a store device
// whose people may not see costs holds every stock move and none of this, and an owner signed in
// there gets it into the in-memory person store instead (least-privilege sync).
import type { ClientMigration } from './types.js';

export const inventoryCostsMigration: ClientMigration = {
  version: 32,
  name: 'inventory_costs',
  statements: [
    `CREATE TABLE inventory_costs (
  movement_id TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  unit_cost   INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  at          INTEGER NOT NULL
)`,
    `CREATE INDEX idx_inventory_costs_item ON inventory_costs (store_id, item_id)`,
  ],
};
