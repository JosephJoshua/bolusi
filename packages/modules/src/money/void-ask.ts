// Whether cancelling a payment goes to an owner instead, the same on the phone and the PC. Only an
// owner (or a manager, as far as their refund limit goes) cancels a payment; whoever takes payments
// asks. What a cancel counts against the limit is read from the ledger the way its rule counts it
// (`voidCounted`, with what was already taken off the servisan), so the screen asks exactly when
// saving would be refused.
import { formatMoney } from '@bolusi/i18n';
import { useEffect, useMemo, useRef } from 'react';

import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import type { ApprovalRow } from '../approvals/queries.js';
import { MONEY_APPROVAL_KIND, MONEY_PERMISSION } from './constants.js';
import { tm, type MoneyKey } from './i18n.js';
import { voidKind } from './kas.js';
import type { MoneyEntryRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime, type MoneyRuntime } from './runtime.js';

export interface VoidAsk {
  /** Cancelling it here would be refused, so the step asks an owner instead. */
  readonly asking: boolean;
  /** Asking is open to this person for this record (a payment on a servisan). */
  readonly mayAsk: boolean;
  /** The count against a limit is still being read (or failed): neither save nor ask yet. */
  readonly pending: boolean;
  readonly because: MoneyKey;
  /** How much this person may take off a servisan's money, null when not limited. */
  readonly limit: number | null;
  /** What this cancel counts against that limit, with what was already taken off. */
  readonly counted: number;
  /** That count when earlier reductions on the servisan add to it, else null: said up front. */
  readonly withEarlier: number | null;
}

export function useVoidAsk(entry: MoneyEntryRow): VoidAsk {
  const runtime = useMoneyRuntime();
  const payment = voidKind(entry).command === 'voidPayment';
  const holds = runtime.hasPermission(MONEY_PERMISSION.voidPayment);
  const limit = payment && holds ? runtime.limitOf(MONEY_PERMISSION.voidPayment) : null;
  const count = useMoneyQuery(
    async (rt) =>
      limit === null
        ? entry.amount
        : ((await rt.query('voidCount', { entryId: entry.id })).rows[0]?.counted ?? entry.amount),
    `voidCount:${entry.id}:${limit ?? ''}`,
  );
  const counted = count.status === 'ready' ? count.data : entry.amount;
  return {
    pending: limit !== null && count.status !== 'ready',
    asking: payment && (!holds || (limit !== null && counted > limit)),
    mayAsk: payment && mayAskVoid(runtime, entry),
    because: holds ? 'money.ask.overLimit' : 'money.ask.needsApproval',
    limit,
    counted,
    withEarlier: limit !== null && counted > entry.amount ? counted : null,
  };
}

function mayAskVoid(runtime: MoneyRuntime, entry: MoneyEntryRow): boolean {
  return (
    entry.documentKind !== null &&
    entry.documentId !== null &&
    runtime.approvals.hasPermission(APPROVAL_PERMISSION.use) &&
    (runtime.hasPermission(MONEY_PERMISSION.receive) ||
      runtime.hasPermission(MONEY_PERMISSION.voidPayment))
  );
}

/** The approval request a cancel asks for: the void itself, about the payment's servisan. */
export function voidRequest(entry: MoneyEntryRow, reason: string) {
  return {
    kind: MONEY_APPROVAL_KIND.voidPayment,
    input: {
      entryId: entry.id,
      reason,
      document: { kind: entry.documentKind ?? '', id: entry.documentId ?? '' },
    },
    reason,
  };
}

/** What became of the cancels this person asked for, and the ones waiting on them. */
export interface VoidRequests {
  /** Payments an owner was asked to cancel and has not answered: the asker's and the decider's. */
  readonly waiting: ReadonlySet<string>;
  /** This person's latest ask per payment, when an owner said no. */
  readonly rejected: ReadonlyMap<string, ApprovalRow>;
  /**
   * Every money ask of this person's an owner said no to, latest per payment or servisan: cancels
   * with refunds and lower bills asked from Kas. The board tells them about these.
   */
  readonly turnedDown: readonly ApprovalRow[];
}

/** The money decisions asked from Kas. */
const KAS_KINDS: ReadonlySet<string> = new Set(Object.values(MONEY_APPROVAL_KIND));

/** What an ask is about: its payment for a cancel, else its kind on its servisan. */
function askedAbout(row: ApprovalRow): string | null {
  if (row.kind === MONEY_APPROVAL_KIND.voidPayment) return entryOf(row);
  return `${row.kind}:${row.targetId}`;
}

function entryOf(row: ApprovalRow): string | null {
  const id = (row.input as { readonly entryId?: unknown }).entryId;
  return typeof id === 'string' ? id : null;
}

/**
 * The cancels asked from Kas as Riwayat marks them and the board tells the asker about: waiting
 * ones (not asked again), and the asker's own an owner turned down (asked again only on purpose).
 */
export function useVoidRequests(): VoidRequests {
  const runtime = useMoneyRuntime();
  const mayAsk = runtime.approvals.hasPermission(APPROVAL_PERMISSION.use);
  const read = useMoneyQuery(async (rt) => {
    if (!mayAsk) return { waiting: [], mine: [] };
    const [waiting, mine] = await Promise.all([
      rt.approvals.query('approvalRequests', {}),
      rt.approvals.query('approvalRequests', { mine: true }),
    ]);
    return {
      waiting: waiting.rows.filter((row) => row.kind === MONEY_APPROVAL_KIND.voidPayment),
      mine: mine.rows.filter((row) => KAS_KINDS.has(row.kind)),
    };
  }, `voidRequests:${mayAsk}`);
  const data = read.status === 'ready' ? read.data : null;
  return useMemo(() => {
    const waiting = new Set<string>();
    const rejected = new Map<string, ApprovalRow>();
    const turnedDown: ApprovalRow[] = [];
    for (const row of data?.waiting ?? []) {
      const id = entryOf(row);
      if (id !== null) waiting.add(id);
    }
    // Newest first: only the latest ask about a payment (or a servisan's refund) counts.
    const seen = new Set<string>();
    for (const row of data?.mine ?? []) {
      const about = askedAbout(row);
      if (about === null || seen.has(about)) continue;
      seen.add(about);
      if (row.status !== 'rejected') continue;
      turnedDown.push(row);
      if (row.kind === MONEY_APPROVAL_KIND.voidPayment) rejected.set(about, row);
    }
    return { waiting, rejected, turnedDown };
  }, [data]);
}

/** The servisan (or other document) an ask was about, as its input names it. */
function documentOf(row: ApprovalRow): { kind: string; id: string; label: string | null } | null {
  const document = (row.input as { readonly document?: unknown }).document as
    { readonly kind?: unknown; readonly id?: unknown; readonly label?: unknown } | undefined;
  if (typeof document?.kind !== 'string' || typeof document.id !== 'string') return null;
  return {
    kind: document.kind,
    id: document.id,
    label: typeof document.label === 'string' ? document.label : null,
  };
}

/**
 * Whose servisan each turned-down ask was about, and its number when the ask carries it, said with
 * the answer so two of them are told apart.
 */
export function useAskedAbout(rows: readonly ApprovalRow[]): (row: ApprovalRow) => string | null {
  const documents = rows.map(documentOf).filter((d) => d !== null);
  const read = useMoneyQuery(
    async (rt) => (documents.length === 0 ? new Map() : await rt.customersOf(documents)),
    `askedAbout:${documents.map((d) => d.id).join(',')}`,
  );
  const names: ReadonlyMap<string, string> = read.status === 'ready' ? read.data : new Map();
  return (row) => {
    const document = documentOf(row);
    if (document === null) return null;
    const parts = [names.get(document.id), document.label].filter(
      (part): part is string => part !== undefined && part !== null && part !== '',
    );
    return parts.length === 0 ? null : parts.join(' · ');
  };
}

/** How a turned-down ask reads, by what was asked. */
const REJECTED_COPY: Readonly<Record<string, readonly [MoneyKey, MoneyKey]>> = {
  [MONEY_APPROVAL_KIND.voidPayment]: ['money.void.rejected', 'money.void.rejectedNote'],
  [MONEY_APPROVAL_KIND.refund]: ['money.refund.rejected', 'money.refund.rejectedNote'],
  [MONEY_APPROVAL_KIND.reduceCharge]: ['money.reduce.rejected', 'money.reduce.rejectedNote'],
};

/** What the asker is told on the board: each money ask an owner turned down since `since`. */
export function turnedDownLines(
  asks: VoidRequests,
  since: number,
  about: (row: ApprovalRow) => string | null = () => null,
): readonly { id: string; text: string }[] {
  return asks.turnedDown
    .filter((row) => (row.decidedAt ?? 0) >= since)
    .map((row) => {
      const values = { name: row.decidedByName ?? '–', amount: formatMoney(row.amount) };
      const [plain, noted] =
        REJECTED_COPY[row.kind] ?? REJECTED_COPY[MONEY_APPROVAL_KIND.voidPayment]!;
      const said =
        row.note === null || row.note === ''
          ? tm(plain, values)
          : tm(noted, { ...values, note: row.note });
      const what = about(row);
      return { id: row.id, text: what === null ? said : `${what}: ${said}` };
    });
}

/** Whose payment this is (the servisan's customer), null while read or when it has no document. */
export function useEntryCustomer(entry: MoneyEntryRow): string | null {
  const read = useMoneyQuery(
    async (rt) =>
      entry.documentKind === null || entry.documentId === null
        ? null
        : ((await rt.customersOf([{ kind: entry.documentKind, id: entry.documentId }])).get(
            entry.documentId,
          ) ?? null),
    `customer:${entry.documentId ?? ''}`,
  );
  return read.status === 'ready' ? read.data : null;
}

/**
 * Calls `onDecided` once the ask about `entryId` is answered (approved, turned down, or closed),
 * so a "an owner was asked" notice never sits above its own answer. Null asks about nothing.
 */
export function useOnVoidDecided(entryId: string | null, onDecided: () => void): void {
  const asks = useVoidRequests();
  const seenWaiting = useRef(false);
  const decided = useRef(onDecided);
  decided.current = onDecided;
  useEffect(() => {
    seenWaiting.current = false;
  }, [entryId]);
  useEffect(() => {
    if (entryId === null) return;
    if (asks.waiting.has(entryId)) {
      seenWaiting.current = true;
      return;
    }
    if (seenWaiting.current || asks.rejected.has(entryId)) decided.current();
  }, [asks, entryId]);
}
