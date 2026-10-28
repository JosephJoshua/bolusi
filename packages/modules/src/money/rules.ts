// The `money` op rules: what must hold in the current records for each money op to be recorded.
// Run on the device before saving and on the server before accepting a push (core module/op-rules.ts).
//
// The server judges every pushed op on its own, so each rule is safe alone: no op the counter may
// record lets money leave the store without an owner, whatever happens to the ops around it.
//   - A charge must be exactly what the document's module says it costs (documents.ts).
//   - A refund without an owner gives back no more than the customer paid beyond their charges,
//     and only through the account they paid with, so a made-up transfer cannot come back as cash.
//   - Lowering a charge, voiding a payment and settling a cash difference are owners' permissions.
//
// Every read is constrained to the op's own store. Postgres hands `bigint` sums back as strings,
// hence the `Number(...)`.
import { sql, type Kysely } from 'kysely';

import { defineRefusals, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import {
  CASH_ACCOUNT,
  MONEY_ENTRY_ENTITY,
  MONEY_PERMISSION,
  SYSTEM_ACCOUNT,
  paymentAccountIdOf,
  referenceRequired,
  type PaymentAccountKind,
} from './constants.js';
import type { MoneyDocument, MoneyDocumentSources } from './documents.js';
import type { MoneyDatabase } from './schema.js';

type Rule = OpRule<MoneyDatabase>;
type Db = Pick<Kysely<MoneyDatabase>, 'selectFrom'>;

/** Every reason a money change is refused, each with its own copy at `money.refusal.<reason>`. */
export const MONEY_REFUSALS = defineRefusals('money', [
  'alreadyRecorded',
  'documentNotFound',
  'notChargeable',
  'chargeMismatch',
  'aboveCharged',
  'accountNotUsable',
  'referenceRequired',
  'tenderedTooLow',
  'paymentNotFound',
  'alreadyVoided',
  'replacementNotFound',
  'refundAboveCredit',
  'notCharged',
  'refundAbovePaid',
  'notThisStore',
  'accountKindChanged',
  'countNotFound',
  'countSettled',
  'countSuperseded',
  'differenceChanged',
  'overLimit',
] as const);
const { refuse } = MONEY_REFUSALS;

/**
 * A limited role (a manager) uses an owner's decision only as far as its store's limit goes
 * (core authz/limits.ts); owners have no limit.
 */
async function requireWithinLimit(
  op: SignedOperation,
  ctx: Pick<Parameters<Rule>[1], 'withinLimit'>,
  permissionId: string,
  amount: number,
): Promise<void> {
  if (await ctx.withinLimit(op.userId, permissionId, amount)) return;
  throw refuse('overLimit', {
    code: 'PERMISSION_DENIED',
    details: { permissionId, issue: `above the limit for ${amount}` },
  });
}

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

/** Money ops are store-scoped (accounts aside), so a null store never matches a row. */
function storeOf(op: SignedOperation): string {
  return op.storeId ?? '';
}

// ── reads shared with the queries ──────────────────────────────────────────────────────────────

/** The stores a central account names; empty for every store. */
export function centralStoreIds(storeIdsJson: string | null): string[] {
  return JSON.parse(storeIdsJson ?? '[]') as string[];
}

/** Whether this store sees an account: its own, or a central one shared with every store or it. */
export function accountVisibleTo(
  account: { storeId: string | null; storeIds: readonly string[] },
  storeId: string,
): boolean {
  if (account.storeId !== null) return account.storeId === storeId;
  return account.storeIds.length === 0 || account.storeIds.includes(storeId);
}

/**
 * The configured account with this id, if this store may take money through it: an active account
 * it sees. Refunds may also go back through a since deactivated one the customer paid with.
 */
export async function usableAccount(
  db: Db,
  tenantId: string,
  storeId: string,
  accountId: string,
  options: { includeInactive?: boolean } = {},
): Promise<{ kind: PaymentAccountKind } | null> {
  let query = db
    .selectFrom('moneyAccounts')
    .select(['kind', 'storeId', 'storeIdsJson'])
    .where('id', '=', accountId)
    .where('tenantId', '=', tenantId);
  if (options.includeInactive !== true) query = query.where('active', '=', 1);
  const row = await query.executeTakeFirst();
  if (row === undefined) return null;
  if (!accountVisibleTo({ ...row, storeIds: centralStoreIds(row.storeIdsJson) }, storeId)) {
    return null;
  }
  return { kind: row.kind as PaymentAccountKind };
}

/** What the customer owes on a document now: positive owed, negative paid ahead. */
export async function documentBalance(
  db: Db,
  storeId: string,
  document: { kind: string; id: string },
): Promise<number> {
  const row = await db
    .selectFrom('moneyLines')
    .select(sql<string | number>`COALESCE(SUM(debit - credit), 0)`.as('balance'))
    .where('storeId', '=', storeId)
    .where('account', '=', SYSTEM_ACCOUNT.receivable)
    .where('documentKind', '=', document.kind)
    .where('documentId', '=', document.id)
    .executeTakeFirst();
  return Number(row?.balance ?? 0);
}

/** The total of one kind of record on a document. */
export async function documentTotal(
  db: Db,
  storeId: string,
  document: { kind: string; id: string },
  kind: 'charge_recorded' | 'charge_reduced' | 'refund_paid',
): Promise<number> {
  const row = await db
    .selectFrom('moneyEntries')
    .select(sql<string | number>`COALESCE(SUM(amount), 0)`.as('total'))
    .where('storeId', '=', storeId)
    .where('kind', '=', kind)
    .where('documentKind', '=', document.kind)
    .where('documentId', '=', document.id)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/**
 * What the book said was in the drawer when a count was made: the cash recorded before it, where a
 * correction that settled an earlier count stands at that count's moment rather than its own. A
 * count made before the owner settled the previous one, and synced after, so already includes it,
 * whatever order the devices synced in. Counts order by time, then id, as the drawer lists them.
 */
export async function countExpected(
  db: Db,
  storeId: string,
  count: { readonly id: string; readonly createdAt: number },
): Promise<number> {
  const row = await db
    .selectFrom('moneyLines as l')
    .innerJoin('moneyEntries as e', 'e.id', 'l.entryId')
    .leftJoin('moneyEntries as c', (join) =>
      join
        .onRef('c.id', '=', 'e.relatedEntryId')
        .on('e.kind', '=', 'cash_adjusted')
        .on('c.kind', '=', 'cash_counted'),
    )
    .select(sql<string | number>`COALESCE(SUM(l.debit - l.credit), 0)`.as('balance'))
    .where('l.storeId', '=', storeId)
    .where('l.account', '=', CASH_ACCOUNT)
    .where((eb) =>
      eb.or([
        eb.and([eb('c.id', 'is', null), eb('l.at', '<', count.createdAt)]),
        eb('c.createdAt', '<', count.createdAt),
        eb.and([eb('c.createdAt', '=', count.createdAt), eb('c.id', '<', count.id)]),
      ]),
    )
    .executeTakeFirst();
  return Number(row?.balance ?? 0);
}

/** What a document's customer paid through one account, less what went back through it. */
async function netPaidThrough(
  db: Db,
  storeId: string,
  document: { kind: string; id: string },
  account: string,
): Promise<number> {
  const row = await db
    .selectFrom('moneyLines')
    .select(sql<string | number>`COALESCE(SUM(debit - credit), 0)`.as('net'))
    .where('storeId', '=', storeId)
    .where('account', '=', account)
    .where('documentKind', '=', document.kind)
    .where('documentId', '=', document.id)
    .executeTakeFirst();
  return Number(row?.net ?? 0);
}

async function entryExists(db: Db, id: string): Promise<boolean> {
  const row = await db
    .selectFrom('moneyEntries')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  return row !== undefined;
}

// ── the rules ──────────────────────────────────────────────────────────────────────────────────

function alreadyRecorded(op: SignedOperation) {
  return refuse('alreadyRecorded', {
    code: 'VALIDATION_FAILED',
    details: { field: 'entityId', issue: 'already recorded', entityId: op.entityId },
  });
}

async function requireFreshEntry(db: Db, op: SignedOperation): Promise<void> {
  if (await entryExists(db, op.entityId)) throw alreadyRecorded(op);
}

/** The drawer, or a configured account this store may use. Returns its kind. */
async function requireAccount(
  db: Db,
  op: SignedOperation,
  account: string,
  options: { includeInactive?: boolean } = {},
): Promise<PaymentAccountKind | 'cash'> {
  if (account === CASH_ACCOUNT) return 'cash';
  const id = paymentAccountIdOf(account);
  const usable =
    id === null ? null : await usableAccount(db, op.tenantId, storeOf(op), id, options);
  if (usable === null) {
    throw refuse('accountNotUsable', {
      code: 'VALIDATION_FAILED',
      details: { field: 'account', issue: 'not an account this store uses', account },
    });
  }
  return usable.kind;
}

export function createMoneyRules(sources: MoneyDocumentSources) {
  async function requireDocument(db: Db, op: SignedOperation, document: MoneyDocument) {
    const source = sources[document.kind];
    const lookup = { tenantId: op.tenantId, storeId: storeOf(op), documentId: document.id };
    if (source === undefined || !(await source.exists(db as unknown as Kysely<never>, lookup))) {
      throw refuse('documentNotFound', {
        code: 'ENTITY_NOT_FOUND',
        details: { entityType: document.kind, entityId: document.id },
      });
    }
    return { source, lookup };
  }

  /** Exactly what is left to charge for the document, to the revenue account it names. */
  const chargeRecordedRule: Rule = async (op, { db }) => {
    const { document, amount, account } = payloadOf<{
      document: MoneyDocument;
      amount: number;
      account: string;
    }>(op);
    await requireFreshEntry(db, op);
    const { source, lookup } = await requireDocument(db, op, document);
    const expected = await source.charge(db as unknown as Kysely<never>, lookup);
    if (expected === null) {
      throw refuse('notChargeable', {
        details: { entityType: document.kind, entityId: document.id },
      });
    }
    const charged = await documentTotal(db, storeOf(op), document, 'charge_recorded');
    if (charged + amount !== expected.amount || account !== expected.account) {
      throw refuse('chargeMismatch', {
        code: 'VALIDATION_FAILED',
        details: { field: 'amount', issue: `expected ${expected.amount - charged}` },
      });
    }
  };

  /**
   * An owner takes something off a document's charges, never more than was charged; a limited role
   * (a manager) only while everything taken off it stays within its store's limit.
   */
  const chargeReducedRule: Rule = async (op, ctx) => {
    const { db } = ctx;
    const { document, amount } = payloadOf<{ document: MoneyDocument; amount: number }>(op);
    await requireFreshEntry(db, op);
    await requireDocument(db, op, document);
    const store = storeOf(op);
    const charged = await documentTotal(db, store, document, 'charge_recorded');
    const reduced = await documentTotal(db, store, document, 'charge_reduced');
    if (reduced + amount > charged) {
      throw refuse('aboveCharged', {
        code: 'VALIDATION_FAILED',
        details: { field: 'amount', issue: `at most ${charged - reduced}` },
      });
    }
    await requireWithinLimit(op, ctx, MONEY_PERMISSION.refund, reduced + amount);
  };

  const paymentReceivedRule: Rule = async (op, { db }) => {
    const { document, account, amount, reference, tendered, replaces } = payloadOf<{
      document: MoneyDocument;
      account: string;
      amount: number;
      reference: string | null;
      tendered: number | null;
      replaces?: string;
    }>(op);
    await requireFreshEntry(db, op);
    await requireDocument(db, op, document);
    const kind = await requireAccount(db, op, account);
    if (referenceRequired(kind) && (reference === null || reference.trim() === '')) {
      throw refuse('referenceRequired', {
        code: 'VALIDATION_FAILED',
        details: { field: 'reference', issue: 'required for this account' },
      });
    }
    if (tendered !== null && (account !== CASH_ACCOUNT || tendered < amount)) {
      throw refuse('tenderedTooLow', {
        code: 'VALIDATION_FAILED',
        details: { field: 'tendered', issue: 'cash handed over is less than the payment' },
      });
    }
    if (replaces !== undefined) await requireReplaceable(db, op, document, account, replaces);
  };

  /**
   * An owner cancels a payment of this store that still counts. A limited role (a manager) may
   * only while the money voids took off its document stays within its store's refund limit: a void
   * takes money off the book like a refund does.
   */
  const paymentVoidedRule: Rule = async (op, ctx) => {
    const { db } = ctx;
    const entry = await db
      .selectFrom('moneyEntries')
      .select(['id', 'kind', 'voidedBy', 'amount', 'documentKind', 'documentId'])
      .where('id', '=', op.entityId)
      .where('storeId', '=', storeOf(op))
      .executeTakeFirst();
    if (entry === undefined || entry.kind !== 'payment_received') {
      throw refuse('paymentNotFound', {
        code: 'ENTITY_NOT_FOUND',
        details: { entityType: MONEY_ENTRY_ENTITY, entityId: op.entityId },
      });
    }
    if (entry.voidedBy !== null) {
      throw refuse('alreadyVoided', { details: { entityId: op.entityId } });
    }
    const takenOff =
      entry.documentKind === null || entry.documentId === null
        ? Number(entry.amount)
        : await voidedOffDocument(db, storeOf(op), {
            kind: entry.documentKind,
            id: entry.documentId,
            voiding: { id: entry.id, amount: Number(entry.amount) },
          });
    await requireWithinLimit(op, ctx, MONEY_PERMISSION.voidPayment, takenOff);
  };

  /**
   * Money back to a customer. The counter may return what the customer paid beyond their charges,
   * through the account they paid with (the change of an overpayment, or a cancelled servisan's DP
   * less its fee), and only once the document is charged in full, so a DP on an unfinished
   * repair is not handed back by the counter. Anything else is an owner's refund.
   */
  const refundPaidRule: Rule = async (op, ctx) => {
    const { db, holdsPermission } = ctx;
    const { document, account, amount } = payloadOf<{
      document: MoneyDocument;
      account: string;
      amount: number;
    }>(op);
    await requireFreshEntry(db, op);
    const { source, lookup } = await requireDocument(db, op, document);
    // A since deactivated account may still give back what was paid through it.
    await requireAccount(db, op, account, { includeInactive: true });
    const store = storeOf(op);
    const counterRefusal = await (async () => {
      // Charged at least what the document costs: a later price drop only shrinks the credit.
      const expected = await source.charge(db as unknown as Kysely<never>, lookup);
      const charged = await documentTotal(db, store, document, 'charge_recorded');
      if (expected === null || charged < expected.amount) {
        return refuse('notCharged', {
          code: 'PERMISSION_DENIED',
          details: { permissionId: MONEY_PERMISSION.refund, issue: 'the document is not charged' },
        });
      }
      const credit = -(await documentBalance(db, store, document));
      const paidThrough = await netPaidThrough(db, store, document, account);
      if (amount > credit || amount > paidThrough) {
        return refuse('refundAboveCredit', {
          code: 'PERMISSION_DENIED',
          details: {
            permissionId: MONEY_PERMISSION.refund,
            issue: `at most ${Math.min(credit, paidThrough)}`,
          },
        });
      }
      return null;
    })();
    if (counterRefusal === null) return;
    if (!(await holdsPermission(op.userId, MONEY_PERMISSION.refund))) throw counterRefusal;
    // A limited role (a manager): every refund on the document, this one with them, within limit.
    const earlier = await documentTotal(db, store, document, 'refund_paid');
    await requireWithinLimit(op, ctx, MONEY_PERMISSION.refund, earlier + amount);
  };

  /** A deposit goes into one of the store's accounts; other moves touch only the drawer. */
  const cashMovedRule: Rule = async (op, { db }) => {
    const { kind, account } = payloadOf<{ kind: string; account: string | null }>(op);
    await requireFreshEntry(db, op);
    if (kind === 'deposit') {
      if (account === null || account === CASH_ACCOUNT) {
        throw refuse('accountNotUsable', {
          code: 'VALIDATION_FAILED',
          details: { field: 'account', issue: 'a deposit names the account it went into' },
        });
      }
      await requireAccount(db, op, account);
    } else if (account !== null) {
      throw refuse('accountNotUsable', {
        code: 'VALIDATION_FAILED',
        details: { field: 'account', issue: `${kind} moves only drawer cash` },
      });
    }
  };

  const cashCountedRule: Rule = async (op, { db }) => {
    await requireFreshEntry(db, op);
  };

  /** An owner's adjustment settles this store's latest count once, when it names one. */
  const cashAdjustedRule: Rule = async (op, { db }) => {
    const { amount, countId } = payloadOf<{ amount: number; countId: string | null }>(op);
    await requireFreshEntry(db, op);
    if (countId === null) return;
    const count = await db
      .selectFrom('moneyEntries')
      .select(['id', 'amount', 'createdAt'])
      .where('id', '=', countId)
      .where('storeId', '=', storeOf(op))
      .where('kind', '=', 'cash_counted')
      .executeTakeFirst();
    if (count === undefined) {
      throw refuse('countNotFound', {
        code: 'ENTITY_NOT_FOUND',
        details: { entityType: MONEY_ENTRY_ENTITY, entityId: countId },
      });
    }
    const settled = await db
      .selectFrom('moneyEntries')
      .select('id')
      .where('storeId', '=', storeOf(op))
      .where('kind', '=', 'cash_adjusted')
      .where('relatedEntryId', '=', countId)
      .executeTakeFirst();
    if (settled !== undefined) {
      throw refuse('countSettled', { details: { entityId: countId } });
    }
    // A later count found this difference again, since it was still in the book: only the latest
    // count is settled, or the drawer would be corrected twice.
    const later = await db
      .selectFrom('moneyEntries')
      .select('id')
      .where('storeId', '=', storeOf(op))
      .where('kind', '=', 'cash_counted')
      // Newest first by time, then id, as the drawer lists them: two counts in one millisecond
      // still have one latest.
      .where((eb) =>
        eb.or([
          eb('createdAt', '>', count.createdAt),
          eb.and([eb('createdAt', '=', count.createdAt), eb('id', '>', count.id)]),
        ]),
      )
      .executeTakeFirst();
    if (later !== undefined) {
      throw refuse('countSuperseded', { details: { entityId: countId } });
    }
    // The correction is the difference as it stands: a payment from before the count that synced
    // since changed it, and the owner settles what the count now shows.
    const counted = Number(count.amount);
    const expected = await countExpected(db, storeOf(op), {
      id: count.id,
      createdAt: Number(count.createdAt),
    });
    if (amount !== counted - expected) {
      throw refuse('differenceChanged', { details: { entityId: countId } });
    }
  };

  return {
    chargeRecordedRule,
    chargeReducedRule,
    paymentReceivedRule,
    paymentVoidedRule,
    refundPaidRule,
    cashMovedRule,
    cashCountedRule,
    cashAdjustedRule,
  };
}

/**
 * A payment recorded in place of another (a corrected DP) names a live payment of the same
 * document, through the same account, that nothing else replaces yet, while the document is not
 * charged: before the bill, what the customer paid is still just the DP.
 */
async function requireReplaceable(
  db: Db,
  op: SignedOperation,
  document: MoneyDocument,
  account: string,
  replaces: string,
): Promise<void> {
  const store = storeOf(op);
  const target = await db
    .selectFrom('moneyEntries')
    .select(['kind', 'voidedBy', 'account', 'documentKind', 'documentId'])
    .where('id', '=', replaces)
    .where('storeId', '=', store)
    .executeTakeFirst();
  const replacedAlready = await db
    .selectFrom('moneyEntries')
    .select('id')
    .where('storeId', '=', store)
    .where('kind', '=', 'payment_received')
    .where('relatedEntryId', '=', replaces)
    .executeTakeFirst();
  const fits =
    target !== undefined &&
    target.kind === 'payment_received' &&
    target.voidedBy === null &&
    target.documentKind === document.kind &&
    target.documentId === document.id &&
    target.account === account &&
    replacedAlready === undefined &&
    (await documentTotal(db, store, document, 'charge_recorded')) === 0;
  if (!fits) {
    throw refuse('replacementNotFound', {
      code: 'VALIDATION_FAILED',
      details: { field: 'replaces', entityId: replaces },
    });
  }
}

/**
 * The money voids took off a document, the void being judged included. A payment voided after one
 * was recorded in its place counts only beyond what that one holds, and only while the document is
 * not charged: once billed, every void counts in full.
 */
async function voidedOffDocument(
  db: Db,
  storeId: string,
  document: {
    readonly kind: string;
    readonly id: string;
    readonly voiding: { readonly id: string; readonly amount: number };
  },
): Promise<number> {
  const payments = await db
    .selectFrom('moneyEntries')
    .select(['id', 'amount', 'voidedBy', 'relatedEntryId'])
    .where('storeId', '=', storeId)
    .where('kind', '=', 'payment_received')
    .where('documentKind', '=', document.kind)
    .where('documentId', '=', document.id)
    .execute();
  const voided = [
    ...payments
      .filter((row) => row.voidedBy !== null)
      .map((row) => ({ id: row.id, amount: Number(row.amount) })),
    document.voiding,
  ];
  const total = voided.reduce((sum, { amount }) => sum + amount, 0);
  if ((await documentTotal(db, storeId, document, 'charge_recorded')) > 0) return total;
  const credit = voided.reduce((sum, { id, amount }) => {
    const replacement = payments.find((row) => row.relatedEntryId === id);
    return sum + (replacement === undefined ? 0 : Math.min(amount, Number(replacement.amount)));
  }, 0);
  return total - credit;
}

/** An account stays with the store that made it (or central), and keeps its kind. */
async function requireSameAccount(db: Db, op: SignedOperation, kind: string): Promise<void> {
  const existing = await db
    .selectFrom('moneyAccounts')
    .select(['storeId', 'kind', 'tenantId'])
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (existing === undefined) return;
  if (existing.tenantId !== op.tenantId || existing.storeId !== op.storeId) {
    throw refuse('notThisStore', {
      code: 'PERMISSION_DENIED',
      details: { reason: 'restriction_violated', entityId: op.entityId },
    });
  }
  // Past payments read through the account's kind (an EDC needs its code), so it never changes.
  if (existing.kind !== kind) {
    throw refuse('accountKindChanged', {
      code: 'VALIDATION_FAILED',
      details: { field: 'kind', issue: 'an account keeps its kind' },
    });
  }
}

export const accountSavedRule: Rule = async (op, { db }) => {
  if (op.storeId === null) {
    throw refuse('notThisStore', {
      code: 'PERMISSION_DENIED',
      details: { reason: 'restriction_violated', entityId: op.entityId },
    });
  }
  await requireSameAccount(db, op, payloadOf<{ kind: string }>(op).kind);
};

export const centralAccountSavedRule: Rule = async (op, { db }) => {
  await requireSameAccount(db, op, payloadOf<{ kind: string }>(op).kind);
};
