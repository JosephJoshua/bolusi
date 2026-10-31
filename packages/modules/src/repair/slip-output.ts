// Printing or sending one slip, the same on every client: read the ticket as it is now, build the
// page with this store's header and terms, hand it to the platform, and log a print that landed so
// the next one says "Cetak ulang". Only the screen around it (and the platform's output) differs.
import {
  renderHtml,
  toMonoBitmap,
  type PaperSettings,
  type PrintDocument,
  type PrintImage,
} from '@bolusi/core';

import type { SlipKind } from './constants.js';
import { printableSlips } from './flows.js';
import { paperLabel, paperSettingsFor, readDevicePaper, type PaperChoice } from './paper.js';
import { logoRef, slipDocument, slipSignature, storeHeader, testPageDocument } from './print.js';
import type { PrintSettings, TicketDetailRow } from './queries.js';
import type { RepairPrinting, RepairRuntime } from './runtime.js';

// A logo on a dot-matrix form takes the top three lines at most, centred, so a slip still fits.
const DOT_MATRIX_LOGO_IN = { width: 2.5, height: 0.5 } as const;

/**
 * The store's logo for this paper: as a picture, plus as dots when the store asked for it on
 * dot-matrix and this device can decode it. Null when there is none or it is not here yet.
 */
async function loadLogo(
  printing: RepairPrinting,
  settings: PrintSettings,
  paper: PaperSettings,
): Promise<PrintImage | null> {
  const ref = logoRef(settings);
  const dataUri = ref === null ? null : await printing.imageDataUri(ref);
  if (dataUri === null) return null;
  const onDotMatrix = paper.continuous && settings.logoOnDotMatrix;
  const pixels =
    onDotMatrix && printing.decodeImage !== undefined ? await printing.decodeImage(dataUri) : null;
  return {
    dataUri,
    mono:
      pixels === null
        ? null
        : toMonoBitmap(
            pixels.rgba,
            pixels.width,
            pixels.height,
            DOT_MATRIX_LOGO_IN.width,
            DOT_MATRIX_LOGO_IN.height,
          ),
  };
}

function send(
  printing: RepairPrinting,
  doc: PrintDocument,
  paper: PaperSettings,
  how: 'print' | 'share',
): Promise<SlipOutcome> {
  // A PDF that is sent goes to the customer, so it is their copy only (the last; the store's comes
  // first). A print keeps every copy: the store tears off its own.
  const sent = how === 'share' ? { ...doc, copies: doc.copies.slice(-1) } : doc;
  return printing.output(
    { html: renderHtml(sent, paper), document: sent, jobName: sent.jobName, paper },
    how,
  );
}

export type SlipOutcome = 'done' | 'cancelled' | 'unconfirmed';

/**
 * Prints that landed but could not be logged (a refused or failed save), per ticket and slip, so the
 * next slip from this app still says "Cetak ulang". Nothing retries the log: these count until the
 * app restarts.
 */
const unlogged = new Map<string, number>();

function unloggedKey(ticketId: string, slip: SlipKind): string {
  return `${ticketId}:${slip}`;
}

/**
 * Log a slip that landed. The paper is out either way, so a failed save is counted here and written
 * to the diagnostics log instead of failing the print and having the counter print it again as if
 * it were the first.
 */
export async function logSlipPrinted(
  runtime: RepairRuntime,
  ticketId: string,
  slip: SlipKind,
): Promise<'done'> {
  try {
    await runtime.run('recordSlipPrinted', { ticketId, slip });
  } catch (error) {
    const key = unloggedKey(ticketId, slip);
    unlogged.set(key, (unlogged.get(key) ?? 0) + 1);
    runtime.diagnostics.warn('printed slip could not be logged', {
      ticketId,
      slip,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return 'done';
}

/** The ticket with the prints this app made but could not log counted in. */
function withUnloggedPrints(ticket: TicketDetailRow): TicketDetailRow {
  const extra = (slip: SlipKind) => unlogged.get(unloggedKey(ticket.id, slip)) ?? 0;
  if (extra('intake') === 0 && extra('handover') === 0) return ticket;
  return {
    ...ticket,
    slipPrints: {
      intake: ticket.slipPrints.intake + extra('intake'),
      handover: ticket.slipPrints.handover + extra('handover'),
    },
  };
}

export async function outputSlip(
  runtime: RepairRuntime,
  printing: RepairPrinting,
  ticket: TicketDetailRow,
  slip: SlipKind,
  /** What this kind of device can print on; the slip goes on the one its settings name. */
  papers: readonly PaperChoice[],
  how: 'print' | 'share',
): Promise<SlipOutcome> {
  // The ticket as it reads now, so the print count and a payment just recorded are right.
  const [fresh, settings, storeName, sheet] = await Promise.all([
    runtime.query('getTicket', { ticketId: ticket.id }),
    runtime.query('printSettings', {}),
    printing.storeName(),
    readDevicePaper(printing, papers),
  ]);
  const row = withUnloggedPrints(fresh.rows[0] ?? ticket);
  // Reopened since the screen opened: there is no bill to print yet, so print nothing.
  if (!printableSlips(row).includes(slip)) return 'cancelled';
  const sources = settings.rows[0]!;
  const signatureRef = slipSignature(row, slip);
  const [logo, signatureUri] = await Promise.all([
    loadLogo(printing, sources, sheet),
    signatureRef === null ? null : printing.imageDataUri(signatureRef),
  ]);
  const doc = slipDocument(row, slip, {
    settings: sources,
    storeName,
    logo,
    signature: signatureUri === null ? null : { dataUri: signatureUri, mono: null },
    statusSite: runtime.statusSite,
  });
  const outcome = await send(printing, doc, sheet, how);
  if (outcome === 'done') await logSlipPrinted(runtime, row.id, slip);
  return outcome;
}

/**
 * A test page on this device's printer and paper, with the store's header as slips print it. Not
 * logged: it is about the printer, not a servisan.
 */
export async function outputTestPage(
  runtime: RepairRuntime,
  printing: RepairPrinting,
  papers: readonly PaperChoice[],
): Promise<SlipOutcome> {
  const [settings, storeName, saved] = await Promise.all([
    runtime.query('printSettings', {}),
    printing.storeName(),
    printing.readPaper(),
  ]);
  const sources = settings.rows[0]!;
  const sheet = paperSettingsFor(saved, papers);
  const logo = await loadLogo(printing, sources, sheet);
  const doc = testPageDocument(
    storeHeader(sources, storeName, logo),
    paperLabel(sheet),
    Date.now(),
  );
  return send(printing, doc, sheet, 'print');
}
