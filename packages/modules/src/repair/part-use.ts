// Repair's say over parts taken for a servisan (owner decision, 2026-10-28). The stock rules call
// this on the device and on the server, so these are the only copy of the rule:
//
// - Parts come off the shelf only for a servisan being worked on (in repair, in the store), by its
//   technician or by someone who assigns work (the counter, an owner). A take names who and when.
// - A part goes back only while that servisan is still being worked on; the stock rule caps it at
//   what the servisan took.
// - Once the servisan is repaired, cancelled or handed back, only an owner (inventory.correct_use)
//   can take or put back parts on it, to correct it.
import type { Kysely } from 'kysely';

import { INVENTORY_PERMISSION } from '../inventory/constants.js';
import type { PartUseTarget } from '../inventory/part-use.js';
import { REPAIR_PERMISSION, REPAIR_TICKET_ENTITY } from './constants.js';
import { REPAIR_REFUSALS } from './rules.js';
import type { RepairDatabase } from './schema.js';

const { refuse } = REPAIR_REFUSALS;

export const repairPartUse: PartUseTarget = {
  async check({ op, useId, db, holdsPermission }) {
    const ticket = await (db as Kysely<RepairDatabase>)
      .selectFrom('repairTickets')
      .select(['ticketNumber', 'outcome', 'location', 'technicianId'])
      .where('id', '=', useId)
      .where('tenantId', '=', op.tenantId)
      .where('storeId', '=', op.storeId ?? '')
      .executeTakeFirst();
    if (ticket === undefined) {
      throw refuse('ticketNotFound', {
        code: 'ENTITY_NOT_FOUND',
        details: { entityType: REPAIR_TICKET_ENTITY, entityId: useId },
      });
    }
    const label = { label: ticket.ticketNumber };
    if (await holdsPermission(op.userId, INVENTORY_PERMISSION.correctUse)) return label;
    if (ticket.outcome !== 'in_repair' || ticket.location !== 'in_store') {
      throw refuse('partsNotInWork', {
        details: { entityType: REPAIR_TICKET_ENTITY, entityId: useId },
        message: `ticket ${ticket.ticketNumber} is ${ticket.outcome}/${ticket.location}`,
      });
    }
    if (
      ticket.technicianId !== op.userId &&
      !(await holdsPermission(op.userId, REPAIR_PERMISSION.assign))
    ) {
      throw refuse('partsNotYours', {
        code: 'PERMISSION_DENIED',
        details: { entityType: REPAIR_TICKET_ENTITY, entityId: useId },
      });
    }
    return label;
  },
};
