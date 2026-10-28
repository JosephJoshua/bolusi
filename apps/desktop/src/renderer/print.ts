// Printing on the counter PC. Slips go to the printer picked in Settings without a dialog: a
// dot-matrix form as raw ESC/P text, plain paper as the HTML page. The printer and paper are this
// PC's own settings, kept by the main process. Run outside Electron (the dev server in a browser),
// there is no bridge, so the page goes to the browser's print dialog and the screen asks whether
// it printed.
import { renderEscp, zPaperSettings, type PaperSettings } from '@bolusi/core';
import {
  PrinterProblem,
  type DecodedImage,
  type RepairPrinting,
  type SlipOutput,
} from '@bolusi/modules/repair/desktop';

import type { PrintersBridge } from '../main/bridge.js';

/** The main process's printing calls, when the page runs inside the desktop app. */
export function printersBridge(): PrintersBridge | undefined {
  return (window as { bolusi?: { printers?: PrintersBridge } }).bolusi?.printers;
}

/** Prints one HTML page through the system dialog; resolves once the dialog is up or done. */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
    frame.srcdoc = html;
    frame.onload = () => {
      const view = frame.contentWindow;
      if (view === null) {
        frame.remove();
        reject(new Error('print frame did not load'));
        return;
      }
      // The page must outlive the dialog, whether print() blocks until it closes or returns early.
      view.addEventListener('afterprint', () => frame.remove(), { once: true });
      try {
        view.print();
        resolve();
      } catch (error) {
        frame.remove();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    document.body.append(frame);
  });
}

// A logo bigger than this is scaled down before it is read: the slip needs a couple of inches.
const DECODE_MAX_PX = 1024;

/** The pixels of a `data:` URI picture, through a canvas; null when it does not decode. */
export async function decodeImage(dataUri: string): Promise<DecodedImage | null> {
  try {
    const image = new Image();
    image.src = dataUri;
    await image.decode();
    const scale = Math.min(1, DECODE_MAX_PX / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.drawImage(image, 0, 0, width, height);
    return { rgba: context.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return null;
  }
}

async function sendToPrinter(printers: PrintersBridge, slip: SlipOutput): Promise<'done'> {
  const result = slip.paper.continuous
    ? await printers.printRaw(renderEscp(slip.document, slip.paper), slip.jobName)
    : await printers.printPage(slip.html, slip.paper);
  if (!result.ok) throw new PrinterProblem(result.problem);
  return 'done';
}

/** The demo's printing, with the PC's store name, and its printers when the app has them. */
export function desktopPrinting(
  base: RepairPrinting,
  storeName: string,
  printers: PrintersBridge | undefined = printersBridge(),
): RepairPrinting {
  const named = { ...base, storeName: () => Promise.resolve(storeName) };
  if (printers === undefined) {
    return {
      ...named,
      output: async (slip) => {
        await printHtml(slip.html);
        return 'unconfirmed';
      },
    };
  }
  return {
    ...named,
    readPaper: async (): Promise<PaperSettings | null> => {
      const parsed = zPaperSettings.safeParse((await printers.settings()).paper);
      return parsed.success ? parsed.data : null;
    },
    writePaper: (paper) => printers.setPaper(paper),
    // A PC prints; sharing a PDF is the phone's.
    output: (slip, how) =>
      how === 'share' ? Promise.resolve('cancelled') : sendToPrinter(printers, slip),
    printers: {
      list: async () =>
        (await printers.list()).map((printer) => ({
          name: printer.name,
          label: printer.displayName,
        })),
      chosen: async () => (await printers.settings()).printer,
      choose: (name) => printers.choose(name),
    },
    decodeImage,
  };
}
