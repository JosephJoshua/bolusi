// The transfer op rules, run by the device before saving and by the server before accepting a push.
// Every read is constrained to the op's tenant, and each record to the store that may write it: the
// sender sends, cancels and settles; the receiving store records arrivals.
//
// - A store never receives more of a part than was sent.
// - A cancel takes everything back, so it is allowed only while nothing has arrived or been settled.
//   An arrival the receiving phone recorded before the cancel (by its clock) still counts: the parts
//   are on its shelf. The transfer then reads as over for the sending owner to settle.
// - A settlement only closes what is open: parts missing go back or are written off (with a reason),
//   parts over are settled as arrived.
import type { SignedOperation } from '@bolusi/schemas';

import { requireDeviceNumber } from '../../shared/device-number.js';
import {
  INVENTORY_ITEM_ENTITY,
  INVENTORY_TRANSFER_ENTITY,
  type SettlementOutcome,
} from '../constants.js';
import { INVENTORY_REFUSALS } from '../refusals.js';
import type { InventoryDatabase } from '../schema.js';
import { loadTransferState, settlementFits, transferActions, type TransferState } from './state.js';
import type { OpRule } from '@bolusi/core';

type Rule = OpRule<InventoryDatabase>;
type Db = Parameters<Rule>[1]['db'];

const { refuse } = INVENTORY_REFUSALS;

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

function alreadyRecorded(field: string): Error {
  return refuse('alreadyRecorded', {
    code: 'VALIDATION_FAILED',
    details: { field, issue: 'already exists' },
  });
}

function notFound(transferId: string): Error {
  return refuse('transferNotFound', {
    code: 'ENTITY_NOT_FOUND',
    details: { entityType: INVENTORY_TRANSFER_ENTITY, entityId: transferId },
  });
}

/** The transfer, sent from the op's store. */
async function requireSentHere(
  db: Db,
  op: SignedOperation,
  transferId: string,
): Promise<TransferState> {
  const state = await loadTransferState(db, op.tenantId, transferId);
  if (state === undefined || state.fromStoreId !== op.storeId) throw notFound(transferId);
  return state;
}

function requireOtherStore(state: TransferState, field: string, storeId: string): void {
  if (storeId !== (field === 'toStoreId' ? state.toStoreId : state.fromStoreId)) {
    throw refuse('transferMismatch', {
      code: 'VALIDATION_FAILED',
      details: { field, issue: 'not the store on the transfer' },
    });
  }
}

export const transferSentRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('inventoryTransfers')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('transferId');
  const payload = payloadOf<{
    transferNumber: string;
    toStoreId: string;
    lines: readonly { itemId: string }[];
  }>(op);
  // The server also refuses another business's store (scope); a phone knows only its own.
  if (payload.toStoreId === op.storeId) {
    throw refuse('sameStore', {
      code: 'VALIDATION_FAILED',
      details: { field: 'toStoreId', issue: 'the sending store' },
    });
  }
  const itemIds = payload.lines.map((line) => line.itemId);
  const parts = await db
    .selectFrom('inventoryItems')
    .select(['id', 'archived', 'updatedAt'])
    .where('tenantId', '=', op.tenantId)
    .where('id', 'in', itemIds)
    .execute();
  const byId = new Map(parts.map((part) => [part.id, part]));
  for (const itemId of itemIds) {
    const part = byId.get(itemId);
    if (part === undefined) {
      throw refuse('itemNotFound', {
        code: 'ENTITY_NOT_FOUND',
        details: { entityType: INVENTORY_ITEM_ENTITY, entityId: itemId },
      });
    }
    // As a take: one sent before the part was archived (by phone time) still stands.
    if (Number(part.archived) === 1 && Number(part.updatedAt) <= op.timestamp) {
      throw refuse('itemArchived', { details: { entityId: itemId } });
    }
  }
  await requireDeviceNumber(db, op, {
    number: payload.transferNumber,
    prefix: 'TR-',
    table: 'inventory_transfers',
    column: 'transfer_number',
    notThisDevice: () =>
      refuse('numberNotThisDevice', {
        code: 'VALIDATION_FAILED',
        details: { field: 'transferNumber', issue: 'not minted by this device' },
      }),
    used: () =>
      refuse('numberUsed', {
        code: 'VALIDATION_FAILED',
        details: { field: 'transferNumber', issue: 'already used' },
      }),
  });
};

export const transferReceivedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('inventoryTransferArrivals')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('arrivalId');
  const payload = payloadOf<{
    transferId: string;
    fromStoreId: string;
    lines: readonly { itemId: string; qty: number }[];
  }>(op);
  const state = await loadTransferState(db, op.tenantId, payload.transferId);
  if (state === undefined || state.toStoreId !== op.storeId) throw notFound(payload.transferId);
  requireOtherStore(state, 'fromStoreId', payload.fromStoreId);
  // Received before the sender cancelled (by the receiving phone's clock): the parts are here.
  if (state.cancelledAt !== null && op.timestamp >= state.cancelledAt) {
    throw refuse('transferCancelled', {
      details: { entityType: INVENTORY_TRANSFER_ENTITY, entityId: state.id },
    });
  }
  const lines = new Map(state.lines.map((line) => [line.itemId, line]));
  for (const line of payload.lines) {
    const sent = lines.get(line.itemId);
    if (sent === undefined) {
      throw refuse('notOnTransfer', {
        code: 'VALIDATION_FAILED',
        details: { field: 'lines', issue: `${line.itemId} is not on the transfer` },
      });
    }
    if (sent.arrived + line.qty > sent.sent) {
      throw refuse('moreThanSent', {
        code: 'VALIDATION_FAILED',
        details: { field: 'qty', issue: `only ${String(sent.sent - sent.arrived)} still to come` },
      });
    }
  }
};

export const transferCancelledRule: Rule = async (op, { db }) => {
  const state = await requireSentHere(db, op, op.entityId);
  requireOtherStore(state, 'toStoreId', payloadOf<{ toStoreId: string }>(op).toStoreId);
  if (!transferActions(state).cancel) {
    throw refuse('nothingToCancel', {
      details: { entityType: INVENTORY_TRANSFER_ENTITY, entityId: state.id },
      message: `transfer ${state.transferNumber} is ${state.stage}`,
    });
  }
};

export const transferSettledRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('inventoryTransferSettlements')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('settlementId');
  const payload = payloadOf<{
    transferId: string;
    toStoreId: string;
    reason: string | null;
    lines: readonly { itemId: string; outcome: SettlementOutcome; qty: number }[];
  }>(op);
  const state = await requireSentHere(db, op, payload.transferId);
  requireOtherStore(state, 'toStoreId', payload.toStoreId);
  if (payload.reason === null && payload.lines.some((line) => line.outcome === 'lost')) {
    throw refuse('reasonRequired', {
      code: 'VALIDATION_FAILED',
      details: { field: 'reason', issue: 'required to write parts off' },
    });
  }
  const lines = new Map(state.lines.map((line) => [line.itemId, line]));
  for (const line of payload.lines) {
    const current = lines.get(line.itemId);
    if (current === undefined) {
      throw refuse('notOnTransfer', {
        code: 'VALIDATION_FAILED',
        details: { field: 'lines', issue: `${line.itemId} is not on the transfer` },
      });
    }
  }
  for (const current of state.lines) {
    if (
      !settlementFits(
        current,
        payload.lines.filter((line) => line.itemId === current.itemId),
      )
    ) {
      throw refuse('nothingToSettle', {
        code: 'VALIDATION_FAILED',
        details: { field: 'lines', issue: `${current.itemId}: ${String(current.missing)} open` },
      });
    }
  }
};
