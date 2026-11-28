// How documents stand in the ledger, many at once: what is still owed, what the customer was
// charged after any owner reduction, and when the last payment came. Read from the lines, as the
// rules read a balance (rules.ts `documentBalance`), so a void counts the moment it is recorded.
// For modules that pay out on settled documents (commission on a servisan paid in full).
import { sql } from 'kysely';

import type { ReadonlyProjectionDb } from '@bolusi/core';

import { chunks } from '../shared/chunks.js';
import { SYSTEM_ACCOUNT } from './constants.js';
import type { MoneyDatabase } from './schema.js';

export interface DocumentSettlement {
  /** Positive while the customer owes, zero or negative once paid in full. */
  readonly balance: number;
  /** Service revenue on it, less what owners took off the bill. */
  readonly revenue: number;
  /** When the last payment that still counts came in; null before any. */
  readonly lastPaidAt: number | null;
}

export async function documentSettlements(
  db: ReadonlyProjectionDb<MoneyDatabase>,
  storeId: string,
  documentKind: string,
  documentIds: readonly string[],
): Promise<Map<string, DocumentSettlement>> {
  const out = new Map<string, DocumentSettlement>();
  const { receivable, serviceRevenue, revenueAdjustment } = SYSTEM_ACCOUNT;
  for (const ids of chunks([...new Set(documentIds)])) {
    const rows = await db
      .selectFrom('moneyLines')
      .select([
        'documentId',
        sql<
          string | number
        >`COALESCE(SUM(CASE WHEN account = ${receivable} THEN debit - credit ELSE 0 END), 0)`.as(
          'balance',
        ),
        sql<
          string | number
        >`COALESCE(SUM(CASE WHEN account = ${serviceRevenue} THEN credit - debit WHEN account = ${revenueAdjustment} THEN credit - debit ELSE 0 END), 0)`.as(
          'revenue',
        ),
        sql<
          string | number | null
        >`MAX(CASE WHEN account = ${receivable} AND credit > 0 THEN at END)`.as('lastPaidAt'),
      ])
      .where('storeId', '=', storeId)
      .where('documentKind', '=', documentKind)
      .where('documentId', 'in', ids)
      .groupBy('documentId')
      .execute();
    for (const row of rows) {
      out.set(row.documentId!, {
        balance: Number(row.balance),
        revenue: Number(row.revenue),
        lastPaidAt: row.lastPaidAt === null ? null : Number(row.lastPaidAt),
      });
    }
  }
  return out;
}
