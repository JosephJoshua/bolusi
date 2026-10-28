// Documents: what a customer can owe money for. A module that charges customers (repair now, POS
// later) declares a document source, so the money rules can check a charge against the module's
// own record without the money module knowing that module. Dependencies point down: the source
// imports from money, and the module list hands the sources to `createMoneyModule`.
//
// The server judges each pushed op on its own (a command's ops are not accepted or refused as a
// group), so every money op must be safe alone. A charge is what lets a cashier give money back
// without an owner (a refund may return what the customer paid beyond their charges), so a charge
// must never be lower than the document says. The source is what says it.
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { zUuid } from '@bolusi/schemas';

import { MAX_DOCUMENT_LABEL, type RevenueAccount } from './constants.js';

/** A document reference, as money payloads carry it. */
export const zDocument = z
  .object({
    kind: z.string().min(1).max(40),
    id: zUuid,
    /** How a person reads it (a servisan number). Never a customer's name: lines are not encrypted. */
    label: z.string().trim().min(1).max(MAX_DOCUMENT_LABEL),
  })
  .strict();
export type MoneyDocument = z.output<typeof zDocument>;

export interface DocumentLookup {
  readonly tenantId: string;
  readonly storeId: string;
  readonly documentId: string;
}

export interface DocumentCharge {
  /** The total the customer is charged for the document, in integer IDR. */
  readonly amount: number;
  readonly account: RevenueAccount;
}

export interface MoneyDocumentSource {
  /** Whether the document exists in this store, so money can be taken for it. */
  exists(db: Kysely<never>, lookup: DocumentLookup): Promise<boolean>;
  /**
   * The full charge for the document as its module's records stand, or null while it cannot be
   * charged yet (a repair still being worked on).
   */
  charge(db: Kysely<never>, lookup: DocumentLookup): Promise<DocumentCharge | null>;
}

/** The registered sources, by document kind. */
export type MoneyDocumentSources = Readonly<Record<string, MoneyDocumentSource>>;
