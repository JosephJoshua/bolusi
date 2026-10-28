// Printing for the counter screens, behind IPC: the PC's printers, the one chosen in Settings, and
// two ways to print on it. A dot-matrix slip goes as raw ESC/P text (`raw-print.ts`); a page for
// plain paper is drawn by Chromium in a hidden window and printed without a dialog. Either way the
// job goes to the chosen printer, so nobody picks one at every print.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrinterInfo, PrintProblem, PrintResult } from './bridge.js';
import { isPrinterName, type DeviceSettingsFile } from './device-settings.js';
import { sendRaw } from './raw-print.js';

// A slip is a few kilobytes of text, or a page with a logo and a signature; anything far past
// that is not a slip.
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_HTML_CHARS = 16 * 1024 * 1024;
const MAX_JOB_NAME = 200;
const MAX_PAPER_JSON = 1024;
const PAGE_TIMEOUT_MS = 120_000;

async function printers(contents: WebContents): Promise<PrinterInfo[]> {
  const list = await contents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
}

/**
 * The printer a job goes to: the one chosen in Settings, while it is still installed. There is no
 * falling back to the Windows default, which is often a PDF printer that would take ESC/P as junk.
 */
async function target(
  contents: WebContents,
  settings: DeviceSettingsFile,
): Promise<{ readonly name: string } | { readonly problem: PrintProblem }> {
  const [{ printer }, list] = await Promise.all([settings.read(), printers(contents)]);
  if (printer === null) return { problem: 'noPrinter' };
  return list.some((p) => p.name === printer) ? { name: printer } : { problem: 'printerMissing' };
}

function jobNameOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_JOB_NAME) : 'Bolusi';
}

function paperSizeOf(value: unknown): { widthMm: number; heightMm: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { widthMm, heightMm } = value as Record<string, unknown>;
  const ok = (mm: unknown): mm is number =>
    typeof mm === 'number' && Number.isFinite(mm) && mm >= 50 && mm <= 600;
  return ok(widthMm) && ok(heightMm) ? { widthMm, heightMm } : null;
}

/** Draws the page in a window nobody sees, with scripts off, and prints it on `printer`. */
async function printPage(
  html: string,
  printer: string,
  size: { widthMm: number; heightMm: number },
): Promise<PrintResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bolusi-page-'));
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  try {
    const file = join(dir, 'page.html');
    await writeFile(file, html, 'utf8');
    await window.loadFile(file);
    return await new Promise<PrintResult>((resolve) => {
      // A driver that never answers leaves the job for lost rather than the counter waiting.
      const timer = setTimeout(() => resolve({ ok: false, problem: 'failed' }), PAGE_TIMEOUT_MS);
      window.webContents.print(
        {
          silent: true,
          deviceName: printer,
          printBackground: true,
          // Microns. The page's own @page rule sets the margins.
          pageSize: { width: size.widthMm * 1000, height: size.heightMm * 1000 },
        },
        (success, reason) => {
          clearTimeout(timer);
          if (!success) console.warn('page print:', reason);
          resolve(success ? { ok: true } : { ok: false, problem: 'failed' });
        },
      );
    });
  } finally {
    window.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface Printing {
  /** Is a print job still on its way to the printer? An update waits for it. */
  busy(): boolean;
}

/**
 * Answers the counter window's print calls. `trusted` says whether a call comes from the app's own
 * page; anything else gets nothing.
 */
export function registerPrinting(
  settings: DeviceSettingsFile,
  trusted: (event: IpcMainInvokeEvent) => boolean,
): Printing {
  let printing = 0;
  const handle = (
    channel: string,
    run: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error(`${channel}: refused`);
      return run(event, ...args);
    });
  };
  const job = async (send: () => Promise<PrintResult>): Promise<PrintResult> => {
    printing += 1;
    try {
      return await send();
    } finally {
      printing -= 1;
    }
  };

  handle('printers:list', (event) => printers(event.sender));
  handle('printers:settings', () => settings.read());
  handle('printers:choose', async (_event, name) => {
    if (name !== null && !isPrinterName(name)) throw new Error('printers:choose: bad name');
    await settings.update({ printer: name });
  });
  handle('printers:set-paper', async (_event, paper) => {
    if (paperSizeOf(paper) === null || JSON.stringify(paper).length > MAX_PAPER_JSON) {
      throw new Error('printers:set-paper: bad paper');
    }
    await settings.update({ paper });
  });
  handle('printers:raw', async (event, bytes, jobName): Promise<PrintResult> => {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_RAW_BYTES) {
      throw new Error('printers:raw: bad job');
    }
    return job(async () => {
      const to = await target(event.sender, settings);
      if ('problem' in to) return { ok: false, problem: to.problem };
      return sendRaw(to.name, bytes, jobNameOf(jobName));
    });
  });
  handle('printers:page', async (event, html, paper): Promise<PrintResult> => {
    const size = paperSizeOf(paper);
    if (typeof html !== 'string' || html.length > MAX_HTML_CHARS || size === null) {
      throw new Error('printers:page: bad page');
    }
    return job(async () => {
      const to = await target(event.sender, settings);
      if ('problem' in to) return { ok: false, problem: to.problem };
      return printPage(html, to.name, size);
    });
  });
  return { busy: () => printing > 0 };
}
