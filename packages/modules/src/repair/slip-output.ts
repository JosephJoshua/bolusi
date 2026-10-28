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
  return printing.output(
    { html: renderHtml(doc, paper), document: doc, jobName: doc.jobName, paper },
    how,
  );
}

export type SlipOutcome = 'done' | 'cancelled' | 'unconfirmed';

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
  const [fresh, settings, storeName, userName, sheet] = await Promise.all([
    runtime.query('getTicket', { ticketId: ticket.id }),
    runtime.query('printSettings', {}),
    printing.storeName(),
    printing.userName(),
    readDevicePaper(printing, papers),
  ]);
  const row = fresh.rows[0] ?? ticket;
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
    printedAt: Date.now(),
    printedByName: userName,
  });
  const outcome = await send(printing, doc, sheet, how);
  if (outcome === 'done') await runtime.run('recordSlipPrinted', { ticketId: row.id, slip });
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
