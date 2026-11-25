// What a transfer says about stock moving, checked by the movement rules on the device and on the
// server: a part leaves or enters a store's stock only as the transfer's own records list it, in its
// quantity, recorded by the same person in the same save. Each movement comes once (the movement
// rules refuse a second one for the same record and part).
import type { Kysely } from 'kysely';

import type { SignedOperation } from '@bolusi/schemas';

import type { SettlementOutcome, StockSinkKind } from '../constants.js';
import { INVENTORY_REFUSALS } from '../refusals.js';
import type { InventoryDatabase } from '../schema.js';
import type { StockSourceTarget } from '../stock-source.js';
import { loadTransferState } from './state.js';

const { refuse } = INVENTORY_REFUSALS;

type Db = Kysely<InventoryDatabase>;

interface LineCheck {
  readonly op: SignedOperation;
  readonly sourceId: string;
  readonly itemId: string;
  readonly qty: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the judging side's projection
  readonly db: Kysely<any>;
}

function mismatch(): Error {
  return refuse('transferMismatch', {
    code: 'VALIDATION_FAILED',
    details: { field: 'qty', issue: 'not as the transfer lists it' },
  });
}

/**
 * The transfer's number, when this store sent it, by this person, with this part: leaving in the
 * qty the transfer lists, to the store it names; or, on a cancel, coming back in the qty that left.
 */
async function sentLine(
  { op, sourceId, itemId, qty, db }: LineCheck,
  cancelled: boolean,
): Promise<{ readonly label: string }> {
  const row = await (db as Db)
    .selectFrom('inventoryTransfers as t')
    .leftJoin('inventoryTransferLines as l', (join) =>
      join.onRef('l.transferId', '=', 't.id').on('l.itemId', '=', itemId),
    )
    .select(['t.transferNumber', 't.toStoreId', 't.sentBy', 't.cancelledBy', 'l.qty'])
    .where('t.id', '=', sourceId)
    .where('t.tenantId', '=', op.tenantId)
    .where('t.storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (row === undefined || row.qty === null) throw mismatch();
  if (cancelled) {
    const line = (await loadTransferState(db as Db, op.tenantId, sourceId))?.lines.find(
      (candidate) => candidate.itemId === itemId,
    );
    if (row.cancelledBy !== op.userId || line?.sent !== qty) throw mismatch();
  } else {
    const { sink } = op.payload as { sink: { toStoreId?: string } };
    if (row.sentBy !== op.userId || Number(row.qty) !== qty || sink.toStoreId !== row.toStoreId) {
      throw mismatch();
    }
  }
  return { label: row.transferNumber };
}

async function arrivalLine({
  op,
  sourceId,
  itemId,
  qty,
  db,
}: LineCheck): Promise<{ readonly label: string }> {
  const row = await (db as Db)
    .selectFrom('inventoryTransferArrivals as a')
    .innerJoin('inventoryTransfers as t', 't.id', 'a.transferId')
    .leftJoin('inventoryTransferArrivalLines as l', (join) =>
      join.onRef('l.arrivalId', '=', 'a.id').on('l.itemId', '=', itemId),
    )
    .select(['t.transferNumber', 'a.userId', 'l.qty'])
    .where('a.id', '=', sourceId)
    .where('a.tenantId', '=', op.tenantId)
    .where('a.storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (
    row === undefined ||
    row.qty === null ||
    Number(row.qty) !== qty ||
    row.userId !== op.userId
  ) {
    throw mismatch();
  }
  return { label: row.transferNumber };
}

async function settlementLine(
  { op, sourceId, itemId, qty, db }: LineCheck,
  outcome: SettlementOutcome,
): Promise<{ readonly label: string }> {
  const row = await (db as Db)
    .selectFrom('inventoryTransferSettlements as s')
    .innerJoin('inventoryTransfers as t', 't.id', 's.transferId')
    .leftJoin('inventoryTransferSettlementLines as l', (join) =>
      join
        .onRef('l.settlementId', '=', 's.id')
        .on('l.itemId', '=', itemId)
        .on('l.outcome', '=', outcome),
    )
    .select(['t.transferNumber', 's.userId', 'l.qty'])
    .where('s.id', '=', sourceId)
    .where('s.tenantId', '=', op.tenantId)
    .where('s.storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (
    row === undefined ||
    row.qty === null ||
    Number(row.qty) !== qty ||
    row.userId !== op.userId
  ) {
    throw mismatch();
  }
  return { label: row.transferNumber };
}

/** Parts coming in from a transfer: at the receiving store, or back at the sender. */
export const TRANSFER_STOCK_SOURCES: Readonly<
  Record<'transfer_arrival' | 'transfer_cancel' | 'transfer_settlement', StockSourceTarget>
> = {
  transfer_arrival: { check: (input) => arrivalLine(input) },
  transfer_cancel: { check: (input) => sentLine(input, true) },
  transfer_settlement: { check: (input) => settlementLine(input, 'back') },
};

/** Parts leaving a store's stock: sent on a transfer, or settled as arrived after being taken back. */
export const STOCK_SINKS: Readonly<
  Record<StockSinkKind, { check(input: LineCheck): Promise<{ readonly label: string }> }>
> = {
  transfer: { check: (input) => sentLine(input, false) },
  transfer_settlement: { check: (input) => settlementLine(input, 'arrived') },
};
