// Client migration 35 — the repair price list (product-scope.md, "Repair price list").
//
// Mirrors server migration 0038. The business's rows, the phone spellings each row covers (so a
// servisan's phone finds its prices by index), and what each store charges instead.
import type { ClientMigration } from './types.js';

export const repairPricesMigration: ClientMigration = {
  version: 35,
  name: 'repair_prices',
  statements: [
    `CREATE TABLE repair_prices (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  repair_type TEXT NOT NULL,
  quality     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  removed     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
    `CREATE INDEX idx_repair_prices_type ON repair_prices (tenant_id, repair_type)`,
    `CREATE TABLE repair_price_models (
  price_id  TEXT NOT NULL,
  model_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (price_id, model_key)
)`,
    `CREATE INDEX idx_repair_price_models_key ON repair_price_models (model_key)`,
    `CREATE TABLE repair_store_prices (
  store_id   TEXT NOT NULL,
  price_id   TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, price_id)
)`,
  ],
};
