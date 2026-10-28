// The `money` projection appliers and table manifests.
//
// Each money record is its own entity (`money_entry`), so an entry's row and its lines re-fold
// together; a void is a second op on the same entity, adding reversing lines rather than deleting
// any, so the books keep both. Configured accounts are the `money_account` entity.
//
// Appliers never throw on business surprises concurrency can produce (two owners voiding one
// payment): the rules refuse those, and the fold accepts whatever the server accepted.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import {
  MONEY_ACCOUNT_ENTITY,
  MONEY_ENTRY_ENTITY,
  MONEY_MODULE_ID,
  type EntryKind,
} from './constants.js';
import type { MoneyDocument } from './documents.js';
import { postingsFor, reversalOf, type Posting } from './postings.js';
import type { MoneyDatabase } from './schema.js';

type Db = Parameters<ProjectionApplier<MoneyDatabase>>[0];

// ── table manifests (column order = DDL order) ─────────────────────────────────────────────────

export const moneyAccountsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    kind: 'text',
    name: 'text',
    active: 'integer',
    store_ids_json: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: MONEY_ACCOUNT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const moneyEntriesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    kind: 'text',
    document_kind: 'text',
    document_id: 'text',
    document_label: 'text',
    account: 'text',
    amount: 'integer',
    sub_kind: 'text',
    reference: 'text',
    reason: 'text',
    tendered: 'integer',
    related_entry_id: 'text',
    created_by: 'text',
    created_at: 'integer',
    voided_by: 'text',
    voided_at: 'integer',
    void_reason: 'text',
  },
  primaryKey: ['id'],
  entityType: MONEY_ENTRY_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const moneyLinesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    entry_id: 'text',
    account: 'text',
    document_kind: 'text',
    document_id: 'text',
    debit: 'integer',
    credit: 'integer',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: MONEY_ENTRY_ENTITY,
  entityIdColumn: 'entry_id',
  projectionVersion: 1,
};

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

function storeIdOf(op: ProjectionOperation): string {
  if (op.storeId === null) {
    throw new Error(`money applier: ${op.type} on ${op.entityId} has a null storeId`);
  }
  return op.storeId;
}

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

function entryKindOf(op: ProjectionOperation): EntryKind {
  return op.type.slice(MONEY_MODULE_ID.length + 1) as EntryKind;
}

async function insertLines(
  db: Db,
  op: ProjectionOperation,
  postings: readonly Posting[],
  document: MoneyDocument | null,
  idPrefix: string,
): Promise<void> {
  if (postings.length === 0) return;
  await db
    .insertInto('moneyLines')
    .values(
      postings.map((p, n) => ({
        id: `${idPrefix}:${n}`,
        tenantId: op.tenantId,
        storeId: storeIdOf(op),
        entryId: op.entityId,
        account: p.account,
        documentKind: document?.kind ?? null,
        documentId: document?.id ?? null,
        debit: p.debit,
        credit: p.credit,
        at: op.timestamp,
      })),
    )
    .execute();
}

interface EntryPayload {
  readonly document?: MoneyDocument;
  readonly amount: number;
  readonly account?: string | null;
  readonly kind?: string;
  readonly reference?: string | null;
  readonly reason?: string;
  readonly note?: string;
  readonly tendered?: number | null;
  readonly countId?: string | null;
  readonly replaces?: string;
}

/** The account an entry moved money through, as its payload names it. */
function entryAccount(kind: EntryKind, payload: EntryPayload): string | null {
  return kind === 'cash_counted' ? null : (payload.account ?? null);
}

// ── appliers ───────────────────────────────────────────────────────────────────────────────────

/** Every record but a void: one entry row and its balanced lines. */
export const entryRecordedApplier: ProjectionApplier<MoneyDatabase> = async (db, op) => {
  const kind = entryKindOf(op);
  const payload = payloadOf<EntryPayload>(op);
  // A count's figure is what was counted; a cash move's kind sits in `subKind`.
  const amount =
    kind === 'cash_counted' ? payloadOf<{ counted: number }>(op).counted : payload.amount;
  const subKind = kind === 'cash_moved' ? (payload.kind ?? null) : null;
  const account = entryAccount(kind, payload);
  const document = payload.document ?? null;
  await db
    .insertInto('moneyEntries')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: storeIdOf(op),
      kind,
      documentKind: document?.kind ?? null,
      documentId: document?.id ?? null,
      documentLabel: document?.label ?? null,
      account,
      amount,
      subKind,
      reference: payload.reference ?? null,
      reason: payload.reason ?? payload.note ?? null,
      tendered: payload.tendered ?? null,
      relatedEntryId: payload.countId ?? payload.replaces ?? null,
      createdBy: op.userId,
      createdAt: op.timestamp,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    })
    .execute();
  await insertLines(db, op, postingsFor({ kind, amount, account, subKind }), document, op.entityId);
};

/**
 * A payment cancelled: the entry is marked and its lines reversed. A second void of the same
 * payment (two owners, offline) changes nothing; the first stands.
 */
export const paymentVoidedApplier: ProjectionApplier<MoneyDatabase> = async (db, op) => {
  const { reason } = payloadOf<{ reason: string }>(op);
  const entry = await db
    .selectFrom('moneyEntries')
    .selectAll()
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .executeTakeFirst();
  if (entry === undefined || entry.voidedBy !== null || entry.kind !== 'payment_received') return;
  await db
    .updateTable('moneyEntries')
    .set({ voidedBy: op.userId, voidedAt: op.timestamp, voidReason: reason })
    .where('id', '=', op.entityId)
    .execute();
  const postings = postingsFor({
    kind: 'payment_received',
    amount: Number(entry.amount),
    account: entry.account,
    subKind: null,
  });
  const document =
    entry.documentKind === null || entry.documentId === null
      ? null
      : { kind: entry.documentKind, id: entry.documentId, label: entry.documentLabel ?? '' };
  await insertLines(db, op, reversalOf(postings), document, `${op.entityId}:void`);
};

/** A store's own account, or a central one: the latest save is the account. */
export const accountSavedApplier: ProjectionApplier<MoneyDatabase> = async (db, op) => {
  const payload = payloadOf<{
    kind: string;
    name: string;
    active: boolean;
    storeIds?: readonly string[];
  }>(op);
  const values = {
    kind: payload.kind,
    name: payload.name,
    active: payload.active ? 1 : 0,
    storeIdsJson: op.storeId === null ? JSON.stringify([...(payload.storeIds ?? [])].sort()) : null,
    updatedBy: op.userId,
    updatedAt: op.timestamp,
  };
  const existing = await db
    .selectFrom('moneyAccounts')
    .select('storeId')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (existing === undefined) {
    await db
      .insertInto('moneyAccounts')
      .values({
        id: op.entityId,
        tenantId: op.tenantId,
        storeId: op.storeId,
        createdAt: op.timestamp,
        ...values,
      })
      .execute();
    return;
  }
  // An account belongs to the store that made it (or stays central): a save from anywhere else is
  // not one a real device writes, and the rule refuses it.
  if (existing.storeId !== op.storeId) return;
  await db.updateTable('moneyAccounts').set(values).where('id', '=', op.entityId).execute();
};
