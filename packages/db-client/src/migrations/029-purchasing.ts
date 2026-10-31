// Client migration 29 — suppliers, orders to them and what arrived (purchasing module).
//
// Mirrors server migration 0032. What an order has received is the sum of its receipt lines, never
// stored on the order, so the (order, part) index serves every "how much is in" read.
import type { ClientMigration } from './types.js';

export const purchasingMigration: ClientMigration = {
  version: 29,
  name: 'purchasing',
  statements: [
    `CREATE TABLE purchasing_suppliers (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT,
  note       TEXT,
  archived   INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
    `CREATE TABLE purchasing_orders (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  store_id      TEXT NOT NULL,
  order_number  TEXT NOT NULL,
  supplier_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  note          TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  ordered_by    TEXT,
  ordered_at    INTEGER,
  cancelled_by  TEXT,
  cancelled_at  INTEGER,
  cancel_reason TEXT,
  updated_at    INTEGER NOT NULL
)`,
    `CREATE INDEX idx_purchasing_orders_store ON purchasing_orders (store_id, status, created_at)`,
    `CREATE TABLE purchasing_order_lines (
  order_id  TEXT NOT NULL,
  position  INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  item_name TEXT NOT NULL,
  qty       INTEGER NOT NULL,
  PRIMARY KEY (order_id, position)
)`,
    `CREATE TABLE purchasing_receipts (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id  TEXT NOT NULL,
  order_id  TEXT NOT NULL,
  note      TEXT,
  user_id   TEXT NOT NULL,
  at        INTEGER NOT NULL
)`,
    `CREATE INDEX idx_purchasing_receipts_order ON purchasing_receipts (order_id, at)`,
    `CREATE TABLE purchasing_receipt_lines (
  receipt_id TEXT NOT NULL,
  position   INTEGER NOT NULL,
  tenant_id  TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  PRIMARY KEY (receipt_id, position)
)`,
    `CREATE INDEX idx_purchasing_receipt_lines_order ON purchasing_receipt_lines (order_id, item_id)`,
  ],
};
