// Client migration 32 — parts sent between stores (inventory transfers).
//
// Mirrors server migration 0034. What a transfer has delivered or settled is the sum of its arrival
// and settlement lines, never stored on the transfer, so the (transfer, part) indexes serve every
// "where are its parts" read.
import type { ClientMigration } from './types.js';

export const transfersMigration: ClientMigration = {
  version: 32,
  name: 'transfers',
  statements: [
    `CREATE TABLE inventory_transfers (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  store_id        TEXT NOT NULL,
  to_store_id     TEXT NOT NULL,
  transfer_number TEXT NOT NULL,
  note            TEXT,
  sent_by         TEXT NOT NULL,
  sent_at         INTEGER NOT NULL,
  cancelled_by    TEXT,
  cancelled_at    INTEGER,
  cancel_reason   TEXT
)`,
    `CREATE INDEX idx_inventory_transfers_from ON inventory_transfers (store_id, sent_at)`,
    `CREATE INDEX idx_inventory_transfers_to ON inventory_transfers (to_store_id, sent_at)`,
    `CREATE TABLE inventory_transfer_lines (
  transfer_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  tenant_id   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  PRIMARY KEY (transfer_id, position)
)`,
    `CREATE TABLE inventory_transfer_arrivals (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  note        TEXT,
  user_id     TEXT NOT NULL,
  at          INTEGER NOT NULL
)`,
    `CREATE INDEX idx_inventory_transfer_arrivals_transfer ON inventory_transfer_arrivals (transfer_id, at)`,
    `CREATE TABLE inventory_transfer_arrival_lines (
  arrival_id  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  tenant_id   TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  PRIMARY KEY (arrival_id, position)
)`,
    `CREATE INDEX idx_inventory_transfer_arrival_lines_transfer ON inventory_transfer_arrival_lines (transfer_id, item_id)`,
    `CREATE TABLE inventory_transfer_settlements (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  reason      TEXT,
  user_id     TEXT NOT NULL,
  at          INTEGER NOT NULL
)`,
    `CREATE INDEX idx_inventory_transfer_settlements_transfer ON inventory_transfer_settlements (transfer_id, at)`,
    `CREATE TABLE inventory_transfer_settlement_lines (
  settlement_id TEXT NOT NULL,
  position      INTEGER NOT NULL,
  tenant_id     TEXT NOT NULL,
  transfer_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  PRIMARY KEY (settlement_id, position)
)`,
    `CREATE INDEX idx_inventory_transfer_settlement_lines_transfer ON inventory_transfer_settlement_lines (transfer_id, item_id)`,
  ],
};
