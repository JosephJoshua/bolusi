// Client migration 19 — the items list, its categories and each store's stock movements
// (inventory module).
//
// Mirrors server migration 0023. Stock is never stored as a total: what a store has is the sum of
// its movements, so the (store, part) index serves every stock read. Versions 16–18 belong to other
// branches; the runner applies by version.
import type { ClientMigration } from './types.js';

export const inventoryMigration: ClientMigration = {
  version: 19,
  name: 'inventory',
  statements: [
    `CREATE TABLE inventory_items (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_auto    INTEGER NOT NULL,
  code         TEXT,
  barcode      TEXT,
  category_id  TEXT,
  field_values TEXT NOT NULL,
  fits         TEXT,
  archived     INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
)`,
    `CREATE TABLE inventory_categories (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_part     INTEGER NOT NULL,
  fields      TEXT NOT NULL,
  name_format TEXT NOT NULL,
  archived    INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
    `CREATE TABLE inventory_item_facets (
  item_id   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  facet     TEXT NOT NULL,
  value     TEXT NOT NULL,
  value_key TEXT NOT NULL,
  PRIMARY KEY (item_id, position)
)`,
    `CREATE TABLE inventory_movements (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id  TEXT NOT NULL,
  item_id   TEXT NOT NULL,
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
    `CREATE TABLE inventory_item_fits (
  item_id   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  brand     TEXT NOT NULL,
  model     TEXT NOT NULL,
  model_key TEXT NOT NULL,
  PRIMARY KEY (item_id, position)
)`,
    `CREATE INDEX idx_inventory_item_facets_value ON inventory_item_facets (facet, value_key)`,
    `CREATE INDEX idx_inventory_item_fits_model ON inventory_item_fits (model_key)`,
    `CREATE INDEX idx_inventory_items_category ON inventory_items (category_id)`,
    `CREATE INDEX idx_inventory_movements_part ON inventory_movements (store_id, item_id, at)`,
    `CREATE INDEX idx_inventory_movements_use ON inventory_movements (use_id)`,
  ],
};
