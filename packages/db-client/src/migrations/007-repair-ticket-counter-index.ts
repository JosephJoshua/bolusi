// Client schema, migration 7 — an index that answers "this device's next ticket counter" in one seek.
//
// Opening a ticket reads the highest counter among the store's tickets that share this device's
// 3-character code (modules/repair/ticket-number.ts). Without this index that read loaded every
// such ticket and parsed each number in JS, so every intake got slower as the store's history grew.
// The counter is the numeric part after `XXX-`; it is indexed as an integer because the padding
// is only four digits, so `XXX-10000` sorts before `XXX-9999` as text. The expressions here must
// match `nextTicketCounterHandler` exactly, or SQLite will not use the index.
//
// Version 6 belongs to the op-log size work. The runner applies by version set, so this index is
// safe whichever of the two lands first.
import type { ClientMigration } from './types.js';

export const repairTicketCounterIndexMigration: ClientMigration = {
  version: 7,
  name: 'repair_ticket_counter_index',
  statements: [
    `CREATE INDEX idx_repair_tickets_device_counter ON repair_tickets (tenant_id, store_id, substr(ticket_number, 1, 4), CAST(substr(ticket_number, 5) AS INTEGER))`,
  ],
};
