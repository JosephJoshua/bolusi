// Settle repair tickets whose ops folded in another order than the server judged them. No schema
// change; the client needs no migration (projection version 4 of repair_tickets and 2 of
// repair_quote_lines re-fold every device), but the server never re-folds, so this does it here.
//
// Canonical fold order sorts by each phone's clock, the server judges ops as they arrive, and the
// appliers used to assume the two agreed. A ticket could end back in repair after an owner's cancel,
// lose a change signed on a phone running behind before the ticket was opened, or keep a price change
// waiting whose decision folded before it, with a total short of what the customer agreed. The
// appliers now land on what the server judged; this brings the existing rows to the same state from
// each ticket's history (repair_ticket_events), the way the fixed appliers replay it:
//
//   - a ticket that had any of those, or a handover taken back, is rebuilt from its history: a cancel
//     is final, a phone handed back stays repaired or cancelled, it is out while its handovers
//     outnumber their undos, and every change counts in time order;
//   - a waiting price change takes its latest approval (approval beats a decline), else its first
//     decline;
//   - every ticket's total is the sum of its lines that count.
import { sql, type Kysely } from 'kysely';

const OP = {
  claimed: 'repair.ticket_claimed',
  assigned: 'repair.technician_assigned',
  repairTypes: 'repair.ticket_repair_types_changed',
  started: 'repair.work_started',
  paused: 'repair.work_paused',
  repaired: 'repair.marked_repaired',
  cancelled: 'repair.ticket_cancelled',
  returned: 'repair.device_returned',
  reversed: 'repair.handover_reversed',
  downPaymentReceived: 'repair.down_payment_received',
  downPaymentCorrected: 'repair.down_payment_corrected',
  quoteChanged: 'repair.quote_changed',
  declined: 'repair.quote_proposal_declined',
} as const;

const TICKET_CHANGE_KINDS = [
  OP.claimed,
  OP.assigned,
  OP.repairTypes,
  OP.started,
  OP.paused,
  OP.repaired,
  OP.cancelled,
  OP.returned,
  OP.reversed,
  OP.downPaymentReceived,
  OP.downPaymentCorrected,
];

interface TicketState {
  outcome: string;
  outcomeNote: string | null;
  location: string;
  technicianId: string | null;
  returnedBy: string | null;
  returnedAt: number | null;
  cancelFee: number | null;
  cancelStandardFee: number | null;
  cancelledBy: string | null;
  cancelledAt: number | null;
  downPayment: number | null;
  downPaymentBy: string | null;
  downPaymentAt: number | null;
  readyAt: number | null;
  repairTypesJson: string;
}

interface EventRow {
  kind: string;
  actorId: string;
  at: string | number;
  detailJson: string;
}

/** JSON with keys sorted at every level, as the appliers store it (JCS for these plain values). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The ticket row its history gives, from the intake on (the appliers' TICKET_CHANGES and guards). */
function replay(repairTypesJson: string, events: readonly EventRow[]): TicketState {
  const s: TicketState = {
    outcome: 'received',
    outcomeNote: null,
    location: 'in_store',
    technicianId: null,
    returnedBy: null,
    returnedAt: null,
    cancelFee: null,
    cancelStandardFee: null,
    cancelledBy: null,
    cancelledAt: null,
    downPayment: null,
    downPaymentBy: null,
    downPaymentAt: null,
    readyAt: null,
    repairTypesJson,
  };
  // Each undo takes back one handover, so the phone is out while handovers outnumber undos.
  let handovers = 0;
  let undos = 0;
  let handedOverBy: string | null = null;
  const settle = (): void => {
    const out = handovers > undos;
    s.location = out ? 'returned' : 'in_store';
    s.returnedBy = out ? handedOverBy : null;
  };
  const working = (): boolean => s.outcome !== 'cancelled' && s.location !== 'returned';
  for (const event of events) {
    const detail = JSON.parse(event.detailJson) as Record<string, unknown>;
    const at = Number(event.at);
    switch (event.kind) {
      case OP.claimed:
        s.technicianId = event.actorId;
        break;
      case OP.assigned:
        s.technicianId = detail['technicianId'] as string;
        break;
      case OP.repairTypes:
        s.repairTypesJson = canonicalJson(detail['repairTypes']);
        break;
      case OP.started:
        if (working()) Object.assign(s, { outcome: 'in_repair', outcomeNote: null, readyAt: null });
        break;
      case OP.paused:
        if (working())
          Object.assign(s, { outcome: 'waiting_for_parts', outcomeNote: detail['note'] });
        break;
      case OP.repaired:
        if (s.outcome !== 'cancelled') {
          Object.assign(s, { outcome: 'repaired', outcomeNote: detail['note'], readyAt: at });
        }
        break;
      case OP.cancelled:
        Object.assign(s, {
          outcome: 'cancelled',
          outcomeNote: detail['reason'],
          cancelFee: (detail['fee'] as number | undefined) ?? null,
          cancelStandardFee: (detail['standardFee'] as number | undefined) ?? null,
          cancelledBy: event.actorId,
          cancelledAt: at,
          readyAt: at,
        });
        break;
      case OP.returned:
        // The warranty and the undo window count from the earliest handover.
        Object.assign(s, {
          outcome: s.outcome === 'cancelled' ? 'cancelled' : 'repaired',
          returnedAt: s.returnedAt === null ? at : Math.min(s.returnedAt, at),
        });
        handovers += 1;
        handedOverBy = event.actorId;
        settle();
        break;
      case OP.reversed:
        undos += 1;
        settle();
        break;
      case OP.downPaymentReceived:
      case OP.downPaymentCorrected: {
        const amount = detail['amount'] as number;
        Object.assign(s, {
          downPayment: amount === 0 ? null : amount,
          downPaymentBy: event.actorId,
          downPaymentAt: at,
        });
        break;
      }
    }
  }
  return s;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const kinds = sql.join(TICKET_CHANGE_KINDS.map((kind) => sql`${kind}`));

  // Tickets a change folded before (signed before the intake), that are back at work after a
  // cancel, or that went home neither repaired nor cancelled.
  const { rows: tickets } = await sql<{ id: string; storeId: string; typesJson: string }>`
    SELECT t.id, t.store_id AS "storeId", t.repair_types_json AS "typesJson" FROM repair_tickets t
    WHERE EXISTS (
        SELECT 1 FROM repair_ticket_events e
        WHERE e.ticket_id = t.id AND e.store_id = t.store_id AND e.kind IN (${kinds})
          AND e.at < t.created_at
      )
      OR (t.outcome <> 'cancelled' AND EXISTS (
        SELECT 1 FROM repair_ticket_events e
        WHERE e.ticket_id = t.id AND e.store_id = t.store_id AND e.kind = ${OP.cancelled}
      ))
      OR (t.location = 'returned' AND t.outcome NOT IN ('repaired', 'cancelled'))
      OR EXISTS (
        SELECT 1 FROM repair_ticket_events e
        WHERE e.ticket_id = t.id AND e.store_id = t.store_id AND e.kind = ${OP.reversed}
      )
  `.execute(db);

  for (const ticket of tickets) {
    const { rows: events } = await sql<EventRow>`
      SELECT kind, actor_id AS "actorId", at, detail_json AS "detailJson" FROM repair_ticket_events
      WHERE ticket_id = ${ticket.id} AND store_id = ${ticket.storeId} AND kind IN (${kinds})
      ORDER BY at, id
    `.execute(db);
    // A types change replaces the intake's types; without one they stand as recorded.
    const s = replay(ticket.typesJson, events);
    await sql`
      UPDATE repair_tickets SET
        outcome = ${s.outcome}, outcome_note = ${s.outcomeNote}, location = ${s.location},
        technician_id = ${s.technicianId}, returned_by = ${s.returnedBy},
        returned_at = ${s.returnedAt}, cancel_fee = ${s.cancelFee},
        cancel_standard_fee = ${s.cancelStandardFee}, cancelled_by = ${s.cancelledBy},
        cancelled_at = ${s.cancelledAt}, down_payment = ${s.downPayment},
        down_payment_by = ${s.downPaymentBy}, down_payment_at = ${s.downPaymentAt},
        ready_at = ${s.readyAt}, repair_types_json = ${s.repairTypesJson}
      WHERE id = ${ticket.id}
    `.execute(db);
  }

  // A price change still waiting (or declined) that a customer approved: the latest approval.
  await sql`
    UPDATE repair_quote_lines l SET
      status = 'applied',
      description = a.detail ->> 'description',
      amount = (a.detail ->> 'amount')::bigint,
      customer_agreed = CASE WHEN (a.detail ->> 'customerAgreed')::boolean THEN 1 ELSE 0 END,
      decided_by = a.actor_id,
      decided_at = a.at,
      decision_note = a.detail ->> 'reason'
    FROM (
      SELECT DISTINCT ON (ticket_id, detail_json::jsonb ->> 'lineId')
        ticket_id, store_id, actor_id, at, detail_json::jsonb AS detail
      FROM repair_ticket_events
      WHERE kind = ${OP.quoteChanged} AND (detail_json::jsonb ->> 'fromProposal')::boolean
      ORDER BY ticket_id, detail_json::jsonb ->> 'lineId', at DESC, id DESC
    ) a
    WHERE l.ticket_id = a.ticket_id AND l.store_id = a.store_id
      AND l.id::text = a.detail ->> 'lineId' AND l.status IN ('proposed', 'declined')
  `.execute(db);

  // One still waiting that was declined: the first decline.
  await sql`
    UPDATE repair_quote_lines l SET
      status = 'declined', decided_by = d.actor_id, decided_at = d.at,
      decision_note = d.detail ->> 'note'
    FROM (
      SELECT DISTINCT ON (ticket_id, detail_json::jsonb ->> 'lineId')
        ticket_id, store_id, actor_id, at, detail_json::jsonb AS detail
      FROM repair_ticket_events
      WHERE kind = ${OP.declined}
      ORDER BY ticket_id, detail_json::jsonb ->> 'lineId', at, id
    ) d
    WHERE l.ticket_id = d.ticket_id AND l.store_id = d.store_id
      AND l.id::text = d.detail ->> 'lineId' AND l.status = 'proposed'
  `.execute(db);

  // Every total is what its lines that count add up to.
  await sql`
    UPDATE repair_tickets t SET quote_total = s.total
    FROM (
      SELECT t2.id, COALESCE(SUM(l.amount) FILTER (WHERE l.status IN ('intake', 'applied')), 0) AS total
      FROM repair_tickets t2 LEFT JOIN repair_quote_lines l ON l.ticket_id = t2.id
      GROUP BY t2.id
    ) s
    WHERE s.id = t.id AND t.quote_total <> s.total
  `.execute(db);
}

/** A data backfill: the rows it settled are the ones the appliers now produce, so nothing to undo. */
export async function down(): Promise<void> {}
