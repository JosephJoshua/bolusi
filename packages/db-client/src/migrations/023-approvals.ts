// Client migration 23 — approval requests (product-scope.md, "Managers, limits, approvals and
// roles"): what someone asked an owner to decide, and the answer.
//
// Mirrors server migration 0027. Version 22 belongs to another branch; the runner applies by version.
import type { ClientMigration } from './types.js';

export const approvalsMigration: ClientMigration = {
  version: 23,
  name: 'approvals',
  statements: [
    `CREATE TABLE approval_requests (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  input_json   TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  basis        TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status       TEXT NOT NULL,
  decided_by   TEXT,
  decided_at   INTEGER,
  note         TEXT
)`,
    `CREATE INDEX idx_approval_requests_target ON approval_requests (target_id, requested_at)`,
    `CREATE INDEX idx_approval_requests_store_status ON approval_requests (store_id, status, requested_at)`,
  ],
};
