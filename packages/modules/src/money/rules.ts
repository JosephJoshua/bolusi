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
  'refundAboveCredit',
  'notThisStore',
  'accountKindChanged',
  'countNotFound',
] as const);
const { refuse } = MONEY_REFUSALS;

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

/** Money ops are store-scoped (accounts aside), so a null store never matches a row. */
function storeOf(op: SignedOperation): string {
  return op.storeId ?? '';
}

// ── reads shared with the queries ──────────────────────────────────────────────────────────────

/**
 * The configured account with this id, if this store may take money through it: its own active
 * account, or an active central one shared with every store or with this one.
 */
export async function usableAccount(
  db: Db,
  tenantId: string,
  storeId: string,
  accountId: string,
): Promise<{ kind: PaymentAccountKind } | null> {
  const row = await db
    .selectFrom('moneyAccounts')
    .select(['kind', 'storeId', 'storeIdsJson'])
    .where('id', '=', accountId)
    .where('tenantId', '=', tenantId)
    .where('active', '=', 1)
    .executeTakeFirst();
  if (row === undefined) return null;
  if (row.storeId === null) {
    const stores = JSON.parse(row.storeIdsJson ?? '[]') as string[];
    if (stores.length > 0 && !stores.includes(storeId)) return null;
  } else if (row.storeId !== storeId) {
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
  kind: 'charge_recorded' | 'charge_reduced',
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
): Promise<PaymentAccountKind | 'cash'> {
  if (account === CASH_ACCOUNT) return 'cash';
  const id = paymentAccountIdOf(account);
  const usable = id === null ? null : await usableAccount(db, op.tenantId, storeOf(op), id);
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

  /** An owner takes something off a document's charges, never more than was charged. */
  const chargeReducedRule: Rule = async (op, { db }) => {
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
  };

  const paymentReceivedRule: Rule = async (op, { db }) => {
    const { document, account, amount, reference, tendered } = payloadOf<{
      document: MoneyDocument;
      account: string;
      amount: number;
      reference: string | null;
      tendered: number | null;
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
  };

  /** An owner cancels a payment of this store that still counts. */
  const paymentVoidedRule: Rule = async (op, { db }) => {
    const entry = await db
      .selectFrom('moneyEntries')
      .select(['kind', 'voidedBy'])
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
  };

  /**
   * Money back to a customer. The counter may return what the customer paid beyond their charges,
   * through the account they paid with (the change of an overpayment, or a cancelled servisan's DP
   * less its fee). Anything more is an owner's refund.
   */
  const refundPaidRule: Rule = async (op, { db, holdsPermission }) => {
    const { document, account, amount } = payloadOf<{
      document: MoneyDocument;
      account: string;
      amount: number;
    }>(op);
    await requireFreshEntry(db, op);
    await requireDocument(db, op, document);
    await requireAccount(db, op, account);
    if (await holdsPermission(op.userId, MONEY_PERMISSION.refund)) return;
    const store = storeOf(op);
    const credit = -(await documentBalance(db, store, document));
    const paidThrough = await netPaidThrough(db, store, document, account);
    if (amount > credit || amount > paidThrough) {
      throw refuse('refundAboveCredit', {
        code: 'PERMISSION_DENIED',
        details: {
          permissionId: MONEY_PERMISSION.refund,
          issue: `at most ${Math.min(credit, paidThrough)}`,
        },
      });
    }
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

  /** An owner's adjustment settles a count of this store, when it names one. */
  const cashAdjustedRule: Rule = async (op, { db }) => {
    const { countId } = payloadOf<{ countId: string | null }>(op);
    await requireFreshEntry(db, op);
    if (countId === null) return;
    const count = await db
      .selectFrom('moneyEntries')
      .select('id')
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
