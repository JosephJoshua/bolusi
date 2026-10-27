// Servisan board benchmark: what the board's reads cost on a device that holds a busy store's
// history (closed tickets included), the reads a live board repeats on every change.
//
//   pnpm --filter @bolusi/modules bench:board                 # 120 days × 40 tickets + 60 open
//   DAYS=365 TICKETS_PER_DAY=50 pnpm --filter @bolusi/modules bench:board
//
// The history is written through the real repair commands and pulled into a device composed as
// the app composes it (replay-device.ts), so names and phones are decrypted on read as on a phone.
// Reads go through the real query handlers and the device's live search cache.
//
// These are Node numbers on the machine that runs the script, not phone numbers. The fuzzy
// search is pure JS, so `SEARCH_DUMP=docs.json` writes the ticket search documents for timing the
// index on Hermes as well.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readOnlyDb, runPullPhase, type QueryContext } from '@bolusi/core';
import { MAX_PULL_LIMIT } from '@bolusi/schemas';
import { opensslPort } from '@bolusi/test-support';
import { SILENT_SURFACE } from '@bolusi/test-support/chaos';

import {
  BOARD_VIEWS,
  boardFilter,
  boardSort,
  repairModule,
  ticketSearchSource,
  type RepairDatabase,
} from '../src/repair/index.js';
import { openFreshDevice, ReplayTransport } from './replay-device.js';
import { writeStoreHistory } from './store-history.js';

/** What a counter types, one keystroke at a time: a name with a typo, a phone, a model. */
const TYPED = ['maria wnda', '0812 44', 'redmi note'];

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

async function time<T>(run: () => Promise<T>, repeat = 5): Promise<{ ms: number; result: T }> {
  const runs: number[] = [];
  let result!: T;
  for (let i = 0; i < repeat; i += 1) {
    const started = performance.now();
    result = await run();
    runs.push(performance.now() - started);
  }
  return { ms: median(runs), result };
}

const ms = (value: number): string => `${value.toFixed(1)} ms`;

async function main(): Promise<void> {
  const days = Number(process.env['DAYS'] ?? 120);
  const ticketsPerDay = Number(process.env['TICKETS_PER_DAY'] ?? 40);
  const openTickets = Number(process.env['OPEN'] ?? 60);

  process.stderr.write(`writing ${days} days × ${ticketsPerDay} tickets + ${openTickets} open\n`);
  const history = await writeStoreHistory({
    days,
    ticketsPerDay,
    openTickets,
    seed: 1,
    onDay: (day) => {
      if (day % 30 === 0) process.stderr.write(`  wrote day ${day}/${days}\n`);
    },
  });
  const { ops, writer } = history;
  const directory = mkdtempSync(join(tmpdir(), 'bolusi-board-'));
  const device = await openFreshDevice(directory);

  try {
    process.stderr.write(`pulling ${ops.length} ops\n`);
    await runPullPhase({
      db: device.conn.db,
      transaction: (fn) => device.conn.transaction(() => fn()),
      transport: new ReplayTransport(ops, [
        {
          id: writer.deviceId,
          storeId: writer.storeId,
          kind: 'member',
          signingKeyPublic: writer.signingKeyPublic,
          status: 'active',
          revokedAt: null,
        },
      ]),
      surface: SILENT_SURFACE,
      crypto: opensslPort,
      clock: { now: () => Date.now() },
      applyPulledOp: (op) => device.engine.applyPulledOp(op),
      limit: MAX_PULL_LIMIT,
    });

    const qctx: QueryContext<RepairDatabase> = {
      db: readOnlyDb(device.conn.db as never),
      tenantId: writer.tenantId,
      storeId: writer.storeId,
      userId: writer.technicianId,
      hasPermission: () => true,
      search: device.search,
    };
    const { listTickets, searchTickets } = repairModule.queries;
    const list = (input: unknown) => listTickets.handler(listTickets.input.parse(input), qctx);
    const search = (text: string) =>
      searchTickets.handler(searchTickets.input.parse({ text, limit: 100 }), qctx);

    const report = [
      `History: ${history.tickets} tickets (${openTickets} still in the shop), ${ops.length} ops`,
    ];

    // The first page of each view: what opening the board or switching a view costs.
    for (const view of BOARD_VIEWS) {
      const { ms: took, result } = await time(() =>
        list({ filter: boardFilter(view, qctx.userId), sort: boardSort(view), limit: 50 }),
      );
      report.push(`View ${view}: first page ${ms(took)} (${result.rows.length} rows)`);
    }

    // A live board re-reads every page it has shown on each change; this is that re-read after
    // scrolling the closed history.
    for (const pages of [1, 5, 20]) {
      const { ms: took } = await time(async () => {
        let cursor: string | null = null;
        for (let n = 0; n < pages; n += 1) {
          const page: { nextCursor: string | null } = await list({
            filter: boardFilter('returned', qctx.userId),
            sort: boardSort('returned'),
            limit: 50,
            ...(cursor === null ? {} : { cursor }),
          });
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
      }, 3);
      report.push(`Returned view re-read after scrolling ${pages} pages: ${ms(took)}`);
    }

    const scope = { tenantId: writer.tenantId, storeId: writer.storeId };
    const started = performance.now();
    const index = await device.search.index(ticketSearchSource, device.conn.db, scope);
    report.push(`First search builds the index: ${ms(performance.now() - started)}`);

    // Every keystroke as the board runs it today: one search per character typed.
    for (const typed of TYPED) {
      const perKey: string[] = [];
      let total = 0;
      let indexTotal = 0;
      for (let end = 1; end <= typed.length; end += 1) {
        const text = typed.slice(0, end);
        if (text.trim() === '') continue;
        const { ms: took } = await time(() => search(text));
        const { ms: indexOnly } = await time(() => Promise.resolve(index.search(text, 100)));
        total += took;
        indexTotal += indexOnly;
        perKey.push(took.toFixed(0));
      }
      report.push(
        `Typing "${typed}": ${ms(total)} over ${typed.length} keys, ${ms(indexTotal)} of it in the index (per key: ${perKey.join(' ')})`,
      );
    }

    if (process.env['SEARCH_DUMP']) {
      const docs = await ticketSearchSource.loadAll(qctx.db, scope);
      writeFileSync(process.env['SEARCH_DUMP'], JSON.stringify(docs));
      report.push(`Wrote ${docs.length} search documents to ${process.env['SEARCH_DUMP']}`);
    }

    process.stdout.write(`${report.join('\n')}\n`);
  } finally {
    await device.conn.close();
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
