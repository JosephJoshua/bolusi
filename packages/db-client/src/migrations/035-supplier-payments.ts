// Client migration 35 — supplier payments ("Bayar supplier", purchasing module).
//
// Mirrors server migration 0037. Read with "Tagihan supplier", as bills are: a device holds these
// only when everyone it syncs for may read bills; an owner on a shared store device reads them in
// their own in-memory store instead.
import type { ClientMigration } from './types.js';

export const supplierPaymentsMigration: ClientMigration = {
  version: 35,
  name: 'supplier_payments',
  statements: [
    `CREATE TABLE purchasing_payments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  bill_id     TEXT,
  amount      INTEGER NOT NULL,
  source      TEXT NOT NULL,
  reference   TEXT,
  note        TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  voided_by   TEXT,
  voided_at   INTEGER,
  void_reason TEXT
)`,
    `CREATE INDEX idx_purchasing_payments_supplier ON purchasing_payments (store_id, supplier_id)`,
    `CREATE INDEX idx_purchasing_payments_bill ON purchasing_payments (bill_id)`,
  ],
};
