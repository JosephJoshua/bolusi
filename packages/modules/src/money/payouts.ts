// Payouts: money paid out for another module's record (a supplier payment, purchasing). That
// module keeps what the money was for and who it went to; the money ledger keeps how much left and
// through which account (the drawer, a bank account, the owner's own money), so Kas reads
// "Bayar supplier", the account and an amount, nothing more.
//
// The ledger's side is recorded under the record's own id and only as that record says: the same
// account, the same amount, by the same person, still standing. So nobody takes money out this way
// without the record behind it, and one record takes money out once. The module list hands each
// payout kind's source in, as it does document sources (documents.ts), so dependencies point down.
import type { Kysely } from 'kysely';

import type { PAYOUT_KINDS } from './constants.js';

export type PayoutKind = (typeof PAYOUT_KINDS)[number];

export interface PayoutLookup {
  readonly tenantId: string;
  readonly storeId: string;
  /** The record's id, which is also the money entry's. */
  readonly id: string;
}

export interface PayoutRecord {
  readonly amount: number;
  /** The ledger account it is paid from: `cash`, `account:<uuid>` or the owner's capital. */
  readonly account: string;
  readonly userId: string;
  readonly voided: boolean;
}

export interface MoneyPayoutSource {
  /** The record in this store, or null when there is none. */
  find(db: Kysely<never>, lookup: PayoutLookup): Promise<PayoutRecord | null>;
}

/** Where each kind of payout's records live. */
export type MoneyPayoutSources = Readonly<Record<PayoutKind, MoneyPayoutSource>>;
