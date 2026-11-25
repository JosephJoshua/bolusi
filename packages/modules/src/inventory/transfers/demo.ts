// Transfers for the browser preview, inside the inventory demo: a few sent from this store and one
// on its way here, kept in memory. Where each part is comes from the same `lineState`, stage and
// actions the real fold uses, so the screens read and offer what they would on a device.
import { DomainError } from '@bolusi/core';

import type { MovementKind, SettlementOutcome } from '../constants.js';
import type { MovementRow } from '../queries.js';
import type { TransferDetailRow, TransferRow } from './queries.js';
import { excessLines, lineState, transferActions, transferStage } from './state.js';

/** This demo store and the business's other ones. */
export const DEMO_STORE_ID = 'store-rufei';
export const DEMO_OTHER_STORES = [
  { id: 'store-sanggeng', name: 'Bolusi Sanggeng' },
  { id: 'store-wosi', name: 'Bolusi Wosi' },
] as const;

const OTHER_STORE_STAFF = { userId: 'u-yohanes', name: 'Yohanes Mandacan' };

interface Who {
  readonly userId: string;
  readonly name: string;
}

interface DemoLine {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
  sent: number;
}

interface DemoTransfer {
  readonly id: string;
  readonly number: string;
  readonly from: string;
  readonly to: string;
  readonly note: string | null;
  readonly sentAt: number;
  readonly sentBy: Who;
  cancelled: { at: number; by: Who } | null;
  readonly lines: DemoLine[];
  readonly arrivals: {
    id: string;
    at: number;
    by: Who;
    note: string | null;
    lines: { itemId: string; qty: number }[];
  }[];
  readonly settlements: {
    id: string;
    at: number;
    by: Who;
    reason: string | null;
    lines: { itemId: string; outcome: SettlementOutcome; qty: number }[];
  }[];
}

export interface DemoTransfersOptions {
  readonly now: number;
  readonly actor: () => Who;
  /** Checks the actor holds a permission, throwing as the real runtime does. */
  readonly require: (permission: string) => Who;
  readonly permissions: {
    readonly transfer: string;
    readonly receive: string;
    readonly settle: string;
  };
  /** A shelf movement, as the inventory demo records one. */
  readonly record: (
    itemId: string,
    kind: MovementKind,
    qty: number,
    extra: Partial<MovementRow> & { at?: number },
  ) => string;
  readonly item: (itemId: string) => { readonly id: string; readonly name: string };
  /** The seeded parts the demo transfers carry, by position on the demo shelf. */
  readonly seedItems: readonly string[];
  readonly newId: (prefix: string) => string;
}

type Input = Record<string, unknown>;

const invalid = (field: string, issue: string) =>
  new DomainError('VALIDATION_FAILED', { field, issue });

export function demoTransfers(options: DemoTransfersOptions) {
  const { now, actor, require, permissions: allow, record, item, newId } = options;
  const transfers: DemoTransfer[] = [];
  const hour = 3_600_000;
  const me = (): Who => actor();
  let counter = 0;

  const send = (
    to: string,
    lines: readonly { itemId: string; qty: number }[],
    note: string | null,
    at: number,
    by: Who,
  ): DemoTransfer => {
    counter += 1;
    const t: DemoTransfer = {
      id: newId('tr'),
      number: `TR-K7Q-${String(counter).padStart(4, '0')}`,
      from: DEMO_STORE_ID,
      to,
      note,
      sentAt: at,
      sentBy: by,
      cancelled: null,
      lines: lines.map((line) => ({ ...line, name: item(line.itemId).name, sent: line.qty })),
      arrivals: [],
      settlements: [],
    };
    for (const line of t.lines) {
      record(line.itemId, 'sent', -line.sent, {
        useKind: 'transfer',
        useId: t.id,
        useLabel: t.number,
        at,
      });
    }
    transfers.push(t);
    return t;
  };

  const states = (t: DemoTransfer) => {
    const total = (rows: readonly { itemId: string; qty: number }[], itemId: string) =>
      rows.filter((row) => row.itemId === itemId).reduce((sum, row) => sum + row.qty, 0);
    const settled = t.settlements.flatMap((s) => s.lines);
    const by = (outcome: SettlementOutcome, itemId: string) =>
      total(
        settled.filter((line) => line.outcome === outcome),
        itemId,
      );
    const lines = t.lines.map((line) =>
      lineState(
        { itemId: line.itemId, name: line.name, listed: line.qty, sent: line.sent },
        {
          arrived: total(
            t.arrivals.flatMap((a) => a.lines),
            line.itemId,
          ),
          back: by('back', line.itemId),
          lost: by('lost', line.itemId),
          found: by('found', line.itemId),
          arrivedLate: by('arrived', line.itemId),
        },
        t.cancelled !== null,
      ),
    );
    const cancelled = t.cancelled !== null;
    return { lines, cancelled, stage: transferStage(cancelled, lines) };
  };

  const toRow = (t: DemoTransfer): TransferRow => {
    const { lines, stage } = states(t);
    return {
      id: t.id,
      transferNumber: t.number,
      direction: t.from === DEMO_STORE_ID ? 'out' : 'in',
      fromStoreId: t.from,
      toStoreId: t.to,
      stage,
      lineCount: lines.length,
      sentQty: lines.reduce((sum, line) => sum + line.sent, 0),
      arrivedQty: lines.reduce((sum, line) => sum + line.arrived, 0),
      missingQty: lines.reduce((sum, line) => sum + Math.max(0, line.missing), 0),
      sentAt: t.sentAt,
      sentBy: t.sentBy.userId,
      sentByName: t.sentBy.name,
    };
  };

  const detail = (t: DemoTransfer): TransferDetailRow => {
    const state = states(t);
    const nameOf = (itemId: string) => t.lines.find((line) => line.itemId === itemId)?.name ?? '';
    const newest = <T extends { at: number }>(rows: readonly T[]) =>
      [...rows].sort((a, b) => b.at - a.at);
    return {
      ...toRow(t),
      note: t.note,
      cancelledAt: t.cancelled?.at ?? null,
      cancelledByName: t.cancelled?.by.name ?? null,
      cancelReason: null,
      lines: state.lines,
      arrivals: newest(t.arrivals).map((a) => ({
        id: a.id,
        at: a.at,
        userId: a.by.userId,
        userName: a.by.name,
        note: a.note,
        lines: a.lines.map((line) => ({ ...line, name: nameOf(line.itemId) })),
      })),
      settlements: newest(t.settlements).map((s) => ({
        id: s.id,
        at: s.at,
        userId: s.by.userId,
        userName: s.by.name,
        reason: s.reason,
        lines: s.lines.map((line) => ({ ...line, name: nameOf(line.itemId) })),
      })),
      can: transferActions(state),
    };
  };

  const find = (transferId: unknown): DemoTransfer => {
    const t = transfers.find((one) => one.id === transferId);
    if (t === undefined) throw new DomainError('ENTITY_NOT_FOUND', { entity: 'transfer' });
    return t;
  };

  // ── the seeded ones ──
  const [lcd, connector, battery, glass, charger, flex] = options.seedItems as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const owner = me();
  // On its way here from Sanggeng: nothing counted in yet.
  transfers.push({
    id: newId('tr'),
    number: 'TR-M2X-0018',
    from: DEMO_OTHER_STORES[0].id,
    to: DEMO_STORE_ID,
    note: 'Titipan untuk servisan Pak Daniel.',
    sentAt: now - 2 * hour,
    sentBy: OTHER_STORE_STAFF,
    cancelled: null,
    lines: [
      { itemId: lcd, name: item(lcd).name, qty: 2, sent: 2 },
      { itemId: connector, name: item(connector).name, qty: 5, sent: 5 },
    ],
    arrivals: [],
    settlements: [],
  });
  // To Wosi: one battery has not arrived, for the owner to settle.
  const partial = send(
    DEMO_OTHER_STORES[1].id,
    [
      { itemId: battery, qty: 3 },
      { itemId: glass, qty: 4 },
    ],
    null,
    now - 26 * hour,
    owner,
  );
  partial.arrivals.push({
    id: newId('ar'),
    at: now - 20 * hour,
    by: OTHER_STORE_STAFF,
    note: 'Baterai kurang satu.',
    lines: [
      { itemId: battery, qty: 2 },
      { itemId: glass, qty: 4 },
    ],
  });
  // To Sanggeng: taken back as never arrived, then counted in there after all.
  const over = send(
    DEMO_OTHER_STORES[0].id,
    [{ itemId: flex, qty: 2 }],
    null,
    now - 72 * hour,
    owner,
  );
  over.settlements.push({
    id: newId('st'),
    at: now - 30 * hour,
    by: owner,
    reason: null,
    lines: [{ itemId: flex, outcome: 'back', qty: 2 }],
  });
  record(flex, 'received', 2, {
    useKind: 'transfer_settlement',
    useId: over.id,
    useLabel: over.number,
    at: now - 30 * hour,
  });
  over.arrivals.push({
    id: newId('ar'),
    at: now - 6 * hour,
    by: OTHER_STORE_STAFF,
    note: null,
    lines: [{ itemId: flex, qty: 1 }],
  });
  // Done, and one cancelled, for the full list.
  const done = send(
    DEMO_OTHER_STORES[0].id,
    [{ itemId: charger, qty: 2 }],
    null,
    now - 96 * hour,
    owner,
  );
  done.arrivals.push({
    id: newId('ar'),
    at: now - 90 * hour,
    by: OTHER_STORE_STAFF,
    note: null,
    lines: [{ itemId: charger, qty: 2 }],
  });
  const cancelled = send(
    DEMO_OTHER_STORES[1].id,
    [{ itemId: glass, qty: 2 }],
    null,
    now - 120 * hour,
    owner,
  );
  cancelled.cancelled = { at: now - 119 * hour, by: owner };
  record(glass, 'received', 2, {
    useKind: 'transfer_cancel',
    useId: cancelled.id,
    useLabel: cancelled.number,
    at: now - 119 * hour,
  });

  const OPEN = ['sent', 'partial', 'over'];
  const queries: Record<string, (input: Input) => unknown> = {
    listTransfers: (input) => ({
      rows: transfers
        .map(toRow)
        .filter((row) => input['filter'] === 'all' || OPEN.includes(row.stage))
        .sort((a, b) => b.sentAt - a.sentAt),
      nextCursor: null,
    }),
    getTransfer: (input) => {
      const t = transfers.find((one) => one.id === input['transferId']);
      return { rows: t === undefined ? [] : [detail(t)], nextCursor: null };
    },
  };

  const commands: Record<string, (input: Input) => unknown> = {
    sendTransfer: (input) => {
      const who = require(allow.transfer);
      const to = String(input['toStoreId'] ?? '');
      if (!DEMO_OTHER_STORES.some((store) => store.id === to))
        throw invalid('toStoreId', 'unknown');
      const lines = (input['lines'] as { itemId: string; qty: number }[]).filter((l) => l.qty > 0);
      if (lines.length === 0) throw invalid('lines', 'empty');
      const note = (input['note'] as string | null | undefined) ?? null;
      return { transferId: send(to, lines, note, Date.now(), who).id };
    },
    receiveTransfer: (input) => {
      const who = require(allow.receive);
      const t = find(input['transferId']);
      const { lines } = states(t);
      const asked = (input['lines'] as { itemId: string; qty: number }[]).filter((l) => l.qty > 0);
      for (const line of asked) {
        const current = lines.find((one) => one.itemId === line.itemId);
        if (current === undefined || line.qty > current.sent - current.arrived) {
          throw invalid('lines', 'more than sent');
        }
      }
      const arrival = {
        id: newId('ar'),
        at: Date.now(),
        by: who,
        note: (input['note'] as string | null | undefined) ?? null,
        lines: asked,
      };
      t.arrivals.push(arrival);
      for (const line of asked) {
        record(line.itemId, 'received', line.qty, {
          useKind: 'transfer_arrival',
          useId: t.id,
          useLabel: t.number,
        });
      }
      return { arrivalId: arrival.id };
    },
    settleTransfer: (input) => {
      const who = require(allow.settle);
      const t = find(input['transferId']);
      const { lines } = states(t);
      const asked = input['lines'] as {
        itemId: string;
        outcome: 'back' | 'lost' | 'arrived';
        qty: number;
      }[];
      const reason = (input['reason'] as string | null | undefined) ?? null;
      if (asked.some((line) => line.outcome === 'lost') && reason === null) {
        throw invalid('reason', 'empty');
      }
      const settled = asked.flatMap(
        (line): { itemId: string; outcome: SettlementOutcome; qty: number }[] => {
          if (line.outcome !== 'arrived') return [line];
          const current = lines.find((one) => one.itemId === line.itemId)!;
          return excessLines(current, line.qty).map((one) => ({ itemId: line.itemId, ...one }));
        },
      );
      const settlement = { id: newId('st'), at: Date.now(), by: who, reason, lines: settled };
      t.settlements.push(settlement);
      for (const line of settled) {
        const extra = { useKind: 'transfer_settlement' as const, useId: t.id, useLabel: t.number };
        if (line.outcome === 'back') record(line.itemId, 'received', line.qty, extra);
        if (line.outcome === 'arrived') record(line.itemId, 'sent', -line.qty, extra);
      }
      return { settlementId: settlement.id };
    },
    cancelTransfer: (input) => {
      const who = require(allow.transfer);
      const t = find(input['transferId']);
      if (!transferActions(states(t)).cancel) throw invalid('transferId', 'not cancellable');
      t.cancelled = { at: Date.now(), by: who };
      for (const line of t.lines.filter((one) => one.sent > 0)) {
        record(line.itemId, 'received', line.sent, {
          useKind: 'transfer_cancel',
          useId: t.id,
          useLabel: t.number,
        });
      }
      return { transferId: t.id };
    },
  };

  return {
    queries,
    commands,
    otherStores: () => Promise.resolve(DEMO_OTHER_STORES),
  };
}
