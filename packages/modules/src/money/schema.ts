// The dialect-neutral shape the `money` appliers and queries are typed against, as repair does
// (see repair/schema.ts). No boolean columns (0/1 integers instead); times are ms epoch integers;
// money is integer IDR. Column order is the DDL order in both migrations and the manifest.

/** A configured payment account: a store's own, or a central one shared by stores. */
export interface MoneyAccountsTable {
  id: string;
  tenantId: string;
  /** The owning store; null for a central account. */
  storeId: string | null;
  /** `qris` | `edc` | `transfer` (cash is each store's drawer and never configured). */
  kind: string;
  name: string;
  /** 0/1: hidden from new payments when 0; past records keep naming it. */
  active: number;
  /** Central accounts only: JSON array of the store ids that use it; `[]` means every store. */
  storeIdsJson: string | null;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

/** One money record. Its lines, if any, are in `money_lines`. */
export interface MoneyEntriesTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** `EntryKind`: the op type without the module prefix. */
  kind: string;
  /** The document it is for (`repair.ticket`), or null for cash moves and counts. */
  documentKind: string | null;
  documentId: string | null;
  /** How the document reads to a person (a servisan number). */
  documentLabel: string | null;
  /** The payment account the money moved through (`cash`, `account:<id>`), or the revenue account. */
  account: string | null;
  /** Always positive, except a cash adjustment, which is signed (more or less cash). */
  amount: number;
  /** A cash move's kind (`CashMoveKind`). */
  subKind: string | null;
  reference: string | null;
  reason: string | null;
  /** What the customer handed over in cash, when the counter typed it, for the change. */
  tendered: number | null;
  /** The count an owner's adjustment settles. */
  relatedEntryId: string | null;
  createdBy: string;
  createdAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

/** The double-entry lines. Each entry's lines balance: total debit = total credit. */
export interface MoneyLinesTable {
  /** `<entry id>:<n>`. */
  id: string;
  tenantId: string;
  storeId: string;
  entryId: string;
  account: string;
  documentKind: string | null;
  documentId: string | null;
  debit: number;
  credit: number;
  /** The entry's time (for a void's reversing lines, the void's). */
  at: number;
}

export interface MoneyDatabase {
  moneyAccounts: MoneyAccountsTable;
  moneyEntries: MoneyEntriesTable;
  moneyLines: MoneyLinesTable;
}
