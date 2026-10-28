// Client migration 19 — the parts list and each store's stock movements (inventory module).
//
// Mirrors server migration 0023. Stock is never stored as a total: what a store has is the sum of
// its movements, so the (store, part) index serves every stock read. Versions 16–18 belong to other
// branches; the runner applies by version.
import type { ClientMigration } from './types.js';

export const inventoryMigration: ClientMigration = {
  version: 19,
  name: 'inventory',
  statements: [
    `CREATE TABLE inventory_parts (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  code       TEXT,
  fits       TEXT,
  archived   INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
    `CREATE TABLE inventory_movements (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id  TEXT NOT NULL,
  part_id   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  qty       INTEGER NOT NULL,
  counted   INTEGER,
  use_kind  TEXT,
  use_id    TEXT,
  use_label TEXT,
  note      TEXT,
  user_id   TEXT NOT NULL,
  at        INTEGER NOT NULL
)`,
    `CREATE TABLE inventory_part_fits (
  part_id   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  brand     TEXT NOT NULL,
  model     TEXT NOT NULL,
  model_key TEXT NOT NULL,
  PRIMARY KEY (part_id, position)
)`,
    `CREATE INDEX idx_inventory_part_fits_model ON inventory_part_fits (model_key)`,
    `CREATE INDEX idx_inventory_movements_part ON inventory_movements (store_id, part_id, at)`,
    `CREATE INDEX idx_inventory_movements_use ON inventory_movements (use_id)`,
  ],
};
