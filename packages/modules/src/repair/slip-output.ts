// Printing or sending one slip, the same on every client: read the ticket as it is now, build the
// page with this store's header and terms, hand it to the platform, and log a print that landed so
// the next one says "Cetak ulang". Only the screen around it (and the platform's output) differs.
import { renderHtml, type PaperSettings } from '@bolusi/core';

import type { SlipKind } from './constants.js';
import { printableSlips } from './flows.js';
import { slipDocument, slipPictures } from './print.js';
import type { TicketDetailRow } from './queries.js';
import type { RepairPrinting, RepairRuntime } from './runtime.js';

export type SlipOutcome = 'done' | 'cancelled' | 'unconfirmed';

export async function outputSlip(
  runtime: RepairRuntime,
  printing: RepairPrinting,
  ticket: TicketDetailRow,
  slip: SlipKind,
  sheet: PaperSettings,
  how: 'print' | 'share',
): Promise<SlipOutcome> {
  // The ticket as it reads now, so the print count and a payment just recorded are right.
  const [fresh, settings, storeName, userName] = await Promise.all([
    runtime.query('getTicket', { ticketId: ticket.id }),
    runtime.query('printSettings', {}),
    printing.storeName(),
    printing.userName(),
  ]);
  const row = fresh.rows[0] ?? ticket;
  // Reopened since the screen opened: there is no bill to print yet, so print nothing.
  if (!printableSlips(row).includes(slip)) return 'cancelled';
  const sources = settings.rows[0]!;
  const pictures = slipPictures(row, slip, sources);
  const [logo, signature] = await Promise.all(
    [pictures.logo, pictures.signature].map(async (ref) => {
      const dataUri = ref === null ? null : await printing.imageDataUri(ref);
      return dataUri === null ? null : { dataUri, mono: null };
    }),
  );
  const doc = slipDocument(row, slip, {
    settings: sources,
    storeName,
    logo: logo ?? null,
    signature: signature ?? null,
    printedAt: Date.now(),
    printedByName: userName,
  });
  await printing.writePaper(sheet);
  const outcome = await printing.output(
    { html: renderHtml(doc, sheet), jobName: doc.jobName, paper: sheet },
    how,
  );
  if (outcome === 'done') await runtime.run('recordSlipPrinted', { ticketId: row.id, slip });
  return outcome;
}
