// Client migration 18 — the `money` ledger: payment accounts, money records and their lines.
//
// Mirrors server migration 0022. Versions 16 and 17 belong to other branches; the runner applies
// by version.
import type { ClientMigration } from './types.js';

export const moneyMigration: ClientMigration = {
  version: 18,
  name: 'money',
  statements: [
    `CREATE TABLE money_accounts (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  store_id       TEXT,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  active         INTEGER NOT NULL,
  store_ids_json TEXT,
  created_at     INTEGER NOT NULL,
  updated_by     TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
)`,
    `CREATE TABLE money_entries (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  store_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  document_kind    TEXT,
  document_id      TEXT,
  document_label   TEXT,
  account          TEXT,
  amount           INTEGER NOT NULL,
  sub_kind         TEXT,
  reference        TEXT,
  reason           TEXT,
  tendered         INTEGER,
  related_entry_id TEXT,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  voided_by        TEXT,
  voided_at        INTEGER,
  void_reason      TEXT
)`,
    `CREATE INDEX idx_money_entries_store_created ON money_entries (tenant_id, store_id, created_at)`,
    `CREATE INDEX idx_money_entries_document ON money_entries (document_id)`,
    `CREATE TABLE money_lines (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  store_id      TEXT NOT NULL,
  entry_id      TEXT NOT NULL,
  account       TEXT NOT NULL,
  document_kind TEXT,
  document_id   TEXT,
  debit         INTEGER NOT NULL,
  credit        INTEGER NOT NULL,
  at            INTEGER NOT NULL
)`,
    `CREATE INDEX idx_money_lines_entry ON money_lines (entry_id)`,
    `CREATE INDEX idx_money_lines_document ON money_lines (document_id, account)`,
    `CREATE INDEX idx_money_lines_store_account ON money_lines (store_id, account, at)`,
  ],
};
