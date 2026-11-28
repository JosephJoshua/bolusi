// Commission on servisan (owner decision 2026-11-28, product-scope.md "Staff pay"): a percentage of
// the profit, what the customer was charged less the cost of the parts, earned once the phone has
// gone home paid in full. Worked out when read, from repair's, money's and stock's own records, so
// a refund, a handover taken back or a part price typed later changes it after the fact, and every
// reader of the same records gets the same figure. The payout rule reads it on the server.
//
// Commission is a running balance: what was earned up to a moment, plus an owner's changes by hand,
// less what payouts already paid. Whatever changes after a payout comes off or onto the next one.
import type { ReadonlyProjectionDb } from '@bolusi/core';

import { PART_USE_KINDS } from '../inventory/constants.js';
import type { InventoryDatabase } from '../inventory/schema.js';
import { costsOfUses } from '../inventory/use-costs.js';
import type { MoneyDatabase } from '../money/schema.js';
import { documentSettlements } from '../money/settlements.js';
import { REPAIR_DOCUMENT_KIND } from '../repair/money-document.js';
import { handedOverRepairs } from '../repair/paid-work.js';
import type { RepairDatabase } from '../repair/schema.js';
import type { PayDatabase } from './schema.js';

/** Any reader over the tables commission reads: a rule's projection or a query's. */
export type CommissionDb = ReadonlyProjectionDb<
  PayDatabase & RepairDatabase & MoneyDatabase & InventoryDatabase
>;

export interface PayScope {
  readonly tenantId: string;
  readonly storeId: string;
}

export interface EarnedServisan {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly technicianId: string;
  /** When it was earned: the later of the handover and the payment that settled it. */
  readonly earnedAt: number;
  /** What the customer was charged, after any owner reduction. */
  readonly revenue: number;
  /** What its parts cost the store; null while a price is not typed yet. */
  readonly partCost: number | null;
  readonly percent: number;
  /** Null while `partCost` is unknown: it counts once the price is typed. */
  readonly commission: number | null;
}

interface Rate {
  readonly at: number;
  readonly percent: number | null;
}

/** The rate in force at `at`: the latest set at or before it, or none. */
function rateAt(rates: readonly Rate[], at: number): Rate | undefined {
  let found: Rate | undefined;
  for (const rate of rates) if (rate.at <= at) found = rate;
  return found;
}

/** Commission on a profit at a percentage: whole rupiah, rounded down; nothing on a loss. */
export function commissionOn(profit: number, percent: number): number {
  return profit <= 0 ? 0 : Math.floor((profit * percent) / 100);
}

/**
 * Every servisan that earned commission at this store up to `until`, for one technician or all.
 * A servisan earns nothing while the store's commission was off at the time it was earned.
 */
export async function earnedServisan(
  db: CommissionDb,
  scope: PayScope,
  options: { readonly until: number; readonly technicianId: string | null },
): Promise<EarnedServisan[]> {
  const storeRates: Rate[] = (
    await db
      .selectFrom('payStoreRates')
      .select(['setAt', 'commissionPercent', 'id'])
      .where('tenantId', '=', scope.tenantId)
      .where('storeId', '=', scope.storeId)
      .orderBy('setAt')
      .orderBy('id')
      .execute()
  ).map((row) => ({
    at: Number(row.setAt),
    percent: row.commissionPercent === null ? null : Number(row.commissionPercent),
  }));
  if (!storeRates.some((rate) => rate.percent !== null)) return [];

  const repairs = await handedOverRepairs(
    db as unknown as ReadonlyProjectionDb<RepairDatabase>,
    scope,
    options,
  );
  if (repairs.length === 0) return [];
  const ids = repairs.map((repair) => repair.id);
  const settled = await documentSettlements(
    db as unknown as ReadonlyProjectionDb<MoneyDatabase>,
    scope.storeId,
    REPAIR_DOCUMENT_KIND,
    ids,
  );

  let termsQuery = db
    .selectFrom('payTerms')
    .select(['userId', 'setAt', 'commissionPercent', 'id'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .orderBy('setAt')
    .orderBy('id');
  if (options.technicianId !== null) {
    termsQuery = termsQuery.where('userId', '=', options.technicianId);
  }
  const ownRates = new Map<string, Rate[]>();
  for (const row of await termsQuery.execute()) {
    const list = ownRates.get(row.userId) ?? [];
    list.push({
      at: Number(row.setAt),
      percent: row.commissionPercent === null ? null : Number(row.commissionPercent),
    });
    ownRates.set(row.userId, list);
  }

  const candidates: {
    repair: (typeof repairs)[number];
    earnedAt: number;
    revenue: number;
    percent: number;
  }[] = [];
  for (const repair of repairs) {
    const money = settled.get(repair.id);
    if (money === undefined || money.balance > 0 || money.revenue <= 0) continue;
    const earnedAt = Math.max(repair.returnedAt, money.lastPaidAt ?? repair.returnedAt);
    if (earnedAt > options.until) continue;
    const store = rateAt(storeRates, earnedAt);
    if (store?.percent === null || store === undefined) continue;
    const own = rateAt(ownRates.get(repair.technicianId) ?? [], earnedAt);
    const percent = own?.percent ?? store.percent;
    candidates.push({ repair, earnedAt, revenue: money.revenue, percent });
  }
  if (candidates.length === 0) return [];

  const costs = await costsOfUses(
    db as unknown as ReadonlyProjectionDb<InventoryDatabase>,
    scope,
    PART_USE_KINDS[0],
    candidates.map((candidate) => candidate.repair.id),
  );
  return candidates
    .map(({ repair, earnedAt, revenue, percent }) => {
      // Null (a price not typed yet) must stay null: only a servisan that took nothing costs 0.
      const partCost = costs.has(repair.id) ? costs.get(repair.id)! : 0;
      return {
        ticketId: repair.id,
        ticketNumber: repair.ticketNumber,
        technicianId: repair.technicianId,
        earnedAt,
        revenue,
        partCost,
        percent,
        commission: partCost === null ? null : commissionOn(revenue - partCost, percent),
      };
    })
    .sort((a, b) => a.earnedAt - b.earnedAt || (a.ticketId < b.ticketId ? -1 : 1));
}

export interface CommissionBalance {
  /** Commission on servisan earned up to the moment, whose part costs are known. */
  readonly earned: number;
  /** An owner's changes by hand up to the moment, signed. */
  readonly adjusted: number;
  /** Commission already paid with payouts that still stand. */
  readonly paid: number;
  /** earned + adjusted − paid: what a payout at that moment pays (negative: taken back). */
  readonly owed: number;
  /** Servisan that wait for a part price before they count. */
  readonly pending: number;
}

/** One person's commission balance at `until`. */
export async function commissionBalance(
  db: CommissionDb,
  scope: PayScope,
  userId: string,
  until: number,
  earned?: readonly EarnedServisan[],
): Promise<CommissionBalance> {
  const servisan = earned ?? (await earnedServisan(db, scope, { until, technicianId: userId }));
  const mine = servisan.filter((row) => row.technicianId === userId);
  const earnedTotal = mine.reduce((sum, row) => sum + (row.commission ?? 0), 0);
  const pending = mine.filter((row) => row.commission === null).length;
  const adjusted = await db
    .selectFrom('payAdjustments')
    .select(['amount'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .where('userId', '=', userId)
    .where('createdAt', '<=', until)
    .execute();
  const paid = await db
    .selectFrom('payPayouts')
    .select(['commission'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .where('userId', '=', userId)
    .where('voidedAt', 'is', null)
    .execute();
  const adjustedTotal = adjusted.reduce((sum, row) => sum + Number(row.amount), 0);
  const paidTotal = paid.reduce((sum, row) => sum + Number(row.commission), 0);
  return {
    earned: earnedTotal,
    adjusted: adjustedTotal,
    paid: paidTotal,
    owed: earnedTotal + adjustedTotal - paidTotal,
    pending,
  };
}
