// Client migration 35 — staff pay (salaries, commission, kasbon, payouts; `pay` module).
//
// Mirrors server migration 0039. A device holds kasbon only when everyone it syncs for keeps
// kasbon, and salaries and payouts only when everyone may read them; an owner on a shared store
// device reads them in their own in-memory store instead.
import type { ClientMigration } from './types.js';

const VOID = `voided_by   TEXT,
  voided_at   INTEGER,
  void_reason TEXT`;

export const staffPayMigration: ClientMigration = {
  version: 35,
  name: 'staff_pay',
  statements: [
    `CREATE TABLE pay_terms (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  store_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  salary             INTEGER NOT NULL,
  commission_percent INTEGER,
  set_by             TEXT NOT NULL,
  set_at             INTEGER NOT NULL
)`,
    `CREATE INDEX idx_pay_terms_user ON pay_terms (store_id, user_id, set_at)`,
    `CREATE TABLE pay_store_rates (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  store_id           TEXT NOT NULL,
  commission_percent INTEGER,
  set_by             TEXT NOT NULL,
  set_at             INTEGER NOT NULL
)`,
    `CREATE INDEX idx_pay_store_rates_store ON pay_store_rates (store_id, set_at)`,
    `CREATE TABLE pay_advances (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  account     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  installment INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ${VOID}
)`,
    `CREATE INDEX idx_pay_advances_user ON pay_advances (store_id, user_id)`,
    `CREATE TABLE pay_repayments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  via         TEXT NOT NULL,
  payout_id   TEXT,
  note        TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ${VOID}
)`,
    `CREATE INDEX idx_pay_repayments_user ON pay_repayments (store_id, user_id)`,
    `CREATE TABLE pay_payouts (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  month        TEXT NOT NULL,
  salary       INTEGER NOT NULL,
  commission   INTEGER NOT NULL,
  deduction    INTEGER NOT NULL,
  repayment_id TEXT,
  paid         INTEGER NOT NULL,
  account      TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  ${VOID}
)`,
    `CREATE INDEX idx_pay_payouts_user ON pay_payouts (store_id, user_id, month)`,
    `CREATE TABLE pay_adjustments (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  store_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
    `CREATE INDEX idx_pay_adjustments_user ON pay_adjustments (store_id, user_id)`,
  ],
};
