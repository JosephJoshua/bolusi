// The transfer queries: this store's transfers, sent from it or to it. Where each one's parts are is
// read through state.ts, the same fold the rules judge by.
import { sql } from 'kysely';
import { z } from 'zod';

import type { QueryContext, QueryPage } from '@bolusi/core';

import { deviceCode } from '../../shared/device-code.js';
import { userNames } from '../../shared/user-names.js';
import { INVENTORY_PERMISSION, type SettlementOutcome, type TransferStage } from '../constants.js';
import type { InventoryDatabase } from '../schema.js';
import {
  loadTransferStates,
  transferActions,
  type TransferLineState,
  type TransferState,
} from './state.js';

type Qctx = QueryContext<InventoryDatabase>;

export interface TransferRow {
  readonly id: string;
  readonly transferNumber: string;
  /** `out` when this store sent it, `in` when it was sent here. */
  readonly direction: 'out' | 'in';
  readonly fromStoreId: string;
  readonly toStoreId: string;
  readonly stage: TransferStage;
  readonly lineCount: number;
  readonly sentQty: number;
  readonly arrivedQty: number;
  /** Still "Belum sampai", summed over its parts (an excess does not offset another's shortfall). */
  readonly missingQty: number;
  readonly sentAt: number;
  readonly sentBy: string;
  readonly sentByName: string | null;
}

export interface TransferArrivalRow {
  readonly id: string;
  readonly at: number;
  readonly userId: string;
  readonly userName: string | null;
  readonly note: string | null;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly qty: number;
  }[];
}

export interface TransferSettlementRow {
  readonly id: string;
  readonly at: number;
  readonly userId: string;
  readonly userName: string | null;
  readonly reason: string | null;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly outcome: SettlementOutcome;
    readonly qty: number;
  }[];
}

export interface TransferDetailRow extends TransferRow {
  readonly note: string | null;
  readonly cancelledAt: number | null;
  readonly cancelledByName: string | null;
  readonly cancelReason: string | null;
  readonly lines: readonly TransferLineState[];
  readonly arrivals: readonly TransferArrivalRow[];
  readonly settlements: readonly TransferSettlementRow[];
  /** What this store may do with it now (permissions aside). */
  readonly can: ReturnType<typeof transferActions>;
}

function toRow(
  state: TransferState,
  storeId: string,
  sentAt: number,
  names: ReadonlyMap<string, string>,
): TransferRow {
  return {
    id: state.id,
    transferNumber: state.transferNumber,
    direction: state.fromStoreId === storeId ? 'out' : 'in',
    fromStoreId: state.fromStoreId,
    toStoreId: state.toStoreId,
    stage: state.stage,
    lineCount: state.lines.length,
    sentQty: state.lines.reduce((sum, line) => sum + line.sent, 0),
    arrivedQty: state.lines.reduce((sum, line) => sum + line.arrived, 0),
    missingQty: state.lines.reduce((sum, line) => sum + Math.max(0, line.missing), 0),
    sentAt,
    sentBy: state.sentBy,
    sentByName: names.get(state.sentBy) ?? null,
  };
}

// ── listTransfers ──────────────────────────────────────────────────────────────────────────────

export const TRANSFER_FILTERS = ['open', 'all'] as const;
export type TransferFilter = (typeof TRANSFER_FILTERS)[number];

export const listTransfersInput = z
  .object({
    direction: z.enum(['all', 'out', 'in']).default('all'),
    /** `open`: still on its way, short, or over; `all` adds the done and cancelled ones. */
    filter: z.enum(TRANSFER_FILTERS).default('open'),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();
export type ListTransfersInput = z.input<typeof listTransfersInput>;

const OPEN_STAGES: readonly TransferStage[] = ['sent', 'partial', 'over'];

/** This store's transfers, newest first. */
export async function listTransfersHandler(
  input: z.output<typeof listTransfersInput>,
  qctx: Qctx,
): Promise<QueryPage<TransferRow>> {
  let query = qctx.db
    .selectFrom('inventoryTransfers')
    .select(['id', 'sentAt'])
    .where('tenantId', '=', qctx.tenantId);
  query =
    input.direction === 'out'
      ? query.where('storeId', '=', qctx.storeId)
      : input.direction === 'in'
        ? query.where('toStoreId', '=', qctx.storeId)
        : query.where((eb) =>
            eb.or([eb('storeId', '=', qctx.storeId), eb('toStoreId', '=', qctx.storeId)]),
          );
  // Open ones are few and must all show, however old; the full list is the newest `limit`.
  if (input.filter === 'all') query = query.orderBy('sentAt', 'desc').limit(input.limit);
  const heads = await query.execute();
  const states = await loadTransferStates(
    qctx.db,
    qctx.tenantId,
    heads.map((row) => row.id),
  );
  const names = await userNames(
    qctx.db,
    [...states.values()].map((state) => state.sentBy),
  );
  const rows = heads
    .map((head) => {
      const state = states.get(head.id);
      return state === undefined
        ? undefined
        : toRow(state, qctx.storeId ?? '', Number(head.sentAt), names);
    })
    .filter((row): row is TransferRow => row !== undefined)
    .filter((row) => input.filter === 'all' || OPEN_STAGES.includes(row.stage))
    .sort((a, b) => b.sentAt - a.sentAt);
  return { rows, nextCursor: null };
}

export const listTransfersQuery = {
  name: 'listTransfers',
  permission: INVENTORY_PERMISSION.read,
  input: listTransfersInput,
  handler: listTransfersHandler,
} as const;

// ── getTransfer ────────────────────────────────────────────────────────────────────────────────

export const getTransferInput = z.object({ transferId: z.string().min(1) }).strict();
export type GetTransferInput = z.input<typeof getTransferInput>;

/** One transfer this store sent or was sent, with its arrivals and settlements, newest first. */
export async function getTransferHandler(
  input: z.output<typeof getTransferInput>,
  qctx: Qctx,
): Promise<QueryPage<TransferDetailRow>> {
  const head = await qctx.db
    .selectFrom('inventoryTransfers')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('id', '=', input.transferId)
    .where((eb) => eb.or([eb('storeId', '=', qctx.storeId), eb('toStoreId', '=', qctx.storeId)]))
    .executeTakeFirst();
  if (head === undefined) return { rows: [], nextCursor: null };
  const state = (await loadTransferStates(qctx.db, qctx.tenantId, [head.id])).get(head.id);
  if (state === undefined) return { rows: [], nextCursor: null };
  const arrivals = await qctx.db
    .selectFrom('inventoryTransferArrivals')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('transferId', '=', head.id)
    .orderBy('at', 'desc')
    .execute();
  const arrivalLines = await qctx.db
    .selectFrom('inventoryTransferArrivalLines')
    .select(['arrivalId', 'itemId', 'qty'])
    .where('tenantId', '=', qctx.tenantId)
    .where('transferId', '=', head.id)
    .orderBy('position')
    .execute();
  const settlements = await qctx.db
    .selectFrom('inventoryTransferSettlements')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('transferId', '=', head.id)
    .orderBy('at', 'desc')
    .execute();
  const settlementLines = await qctx.db
    .selectFrom('inventoryTransferSettlementLines')
    .select(['settlementId', 'itemId', 'outcome', 'qty'])
    .where('tenantId', '=', qctx.tenantId)
    .where('transferId', '=', head.id)
    .orderBy('position')
    .execute();
  const itemName = new Map(state.lines.map((line) => [line.itemId, line.name]));
  const names = await userNames(qctx.db, [
    head.sentBy,
    head.cancelledBy,
    ...arrivals.map((row) => row.userId),
    ...settlements.map((row) => row.userId),
  ]);
  const row: TransferDetailRow = {
    ...toRow(state, qctx.storeId ?? '', Number(head.sentAt), names),
    note: head.note,
    cancelledAt: head.cancelledAt === null ? null : Number(head.cancelledAt),
    cancelledByName: head.cancelledBy === null ? null : (names.get(head.cancelledBy) ?? null),
    cancelReason: head.cancelReason,
    lines: state.lines,
    arrivals: arrivals.map((arrival) => ({
      id: arrival.id,
      at: Number(arrival.at),
      userId: arrival.userId,
      userName: names.get(arrival.userId) ?? null,
      note: arrival.note,
      lines: arrivalLines
        .filter((line) => line.arrivalId === arrival.id)
        .map((line) => ({
          itemId: line.itemId,
          name: itemName.get(line.itemId) ?? '',
          qty: Number(line.qty),
        })),
    })),
    settlements: settlements.map((settlement) => ({
      id: settlement.id,
      at: Number(settlement.at),
      userId: settlement.userId,
      userName: names.get(settlement.userId) ?? null,
      reason: settlement.reason,
      lines: settlementLines
        .filter((line) => line.settlementId === settlement.id)
        .map((line) => ({
          itemId: line.itemId,
          name: itemName.get(line.itemId) ?? '',
          outcome: line.outcome as SettlementOutcome,
          qty: Number(line.qty),
        })),
    })),
    can: transferActions(state),
  };
  return { rows: [row], nextCursor: null };
}

export const getTransferQuery = {
  name: 'getTransfer',
  permission: INVENTORY_PERMISSION.read,
  input: getTransferInput,
  handler: getTransferHandler,
} as const;

// ── nextTransferNumber ─────────────────────────────────────────────────────────────────────────

export const nextTransferNumberInput = z.object({ deviceId: z.string().min(1) }).strict();

/** The next `TR-<device code>-<counter>` for this device, as order numbers are minted. */
export async function nextTransferNumberHandler(
  input: z.output<typeof nextTransferNumberInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly transferNumber: string }>> {
  const prefix = `TR-${deviceCode(input.deviceId)}-`;
  const row = await qctx.db
    .selectFrom('inventoryTransfers')
    .select(
      sql<
        number | null
      >`MAX(CASE WHEN length(transfer_number) BETWEEN 11 AND 16 AND substr(transfer_number, 8) NOT GLOB '*[^0-9]*' THEN CAST(substr(transfer_number, 8) AS INTEGER) END)`.as(
        'counter',
      ),
    )
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where(sql<string>`substr(transfer_number, 1, 7)`, '=', prefix)
    .executeTakeFirst();
  const highest = Number(row?.counter ?? 0);
  return {
    rows: [{ transferNumber: `${prefix}${String(highest + 1).padStart(4, '0')}` }],
    nextCursor: null,
  };
}

export const nextTransferNumberQuery = {
  name: 'nextTransferNumber',
  permission: INVENTORY_PERMISSION.transfer,
  input: nextTransferNumberInput,
  handler: nextTransferNumberHandler,
} as const;
