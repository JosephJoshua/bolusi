// Client schema, migration 5 — an index on `operations.arrival_seq`.
//
// Every pulled op reads `MAX(arrival_seq)` to number itself, and every pulled apply walks
// `arrival_seq > watermark ORDER BY arrival_seq` to advance the watermark. Without an index both are
// full scans of the op log, so a pull costs time proportional to the whole history per op: a new
// device replaying a store's history was quadratic, and every routine pull on a long-lived device
// got slower each month. Own-device ops keep `arrival_seq` NULL; a full (not partial) index is used
// because SQLite only answers `MAX()` from an index the query is guaranteed to match.
import type { ClientMigration } from './types.js';

export const operationsArrivalIndexMigration: ClientMigration = {
  version: 5,
  name: 'operations_arrival_index',
  statements: [`CREATE INDEX idx_operations_arrival_seq ON operations (arrival_seq)`],
};
