// Client migration 34 — supplier bills ("Tagihan supplier", purchasing module).
//
// Mirrors server migration 0036. A device holds these only when everyone it syncs for may read
// bills; an owner on a shared store device reads them in their own in-memory store instead.
import type { ClientMigration } from './types.js';

export const supplierBillsMigration: ClientMigration = {
  version: 34,
  name: 'supplier_bills',
  statements: [
    `CREATE TABLE purchasing_bills (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  bill_number  TEXT NOT NULL,
  supplier_id  TEXT NOT NULL,
  order_id     TEXT,
  supplier_ref TEXT,
  billed_on    INTEGER NOT NULL,
  due_on       INTEGER,
  charges      INTEGER NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  voided_by    TEXT,
  voided_at    INTEGER,
  void_reason  TEXT
)`,
    `CREATE INDEX idx_purchasing_bills_store ON purchasing_bills (store_id, status, due_on)`,
    `CREATE INDEX idx_purchasing_bills_order ON purchasing_bills (order_id)`,
    `CREATE TABLE purchasing_bill_lines (
  bill_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  tenant_id  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  item_name  TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  PRIMARY KEY (bill_id, position)
)`,
  ],
};
