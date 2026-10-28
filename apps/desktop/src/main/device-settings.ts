// This PC's own print settings: which printer the slips go to and the paper in it. They describe
// the hardware on this desk, not the store's data, so they live in a small file beside the app
// rather than in the synced database, and survive signing in again or switching people.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DeviceSettings {
  /** The Windows printer name; null until someone picks one. */
  readonly printer: string | null;
  /** The paper as the renderer saved it; the renderer checks it on read. */
  readonly paper: unknown;
}

const EMPTY: DeviceSettings = { printer: null, paper: null };
const MAX_PRINTER_NAME = 256;

export function isPrinterName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PRINTER_NAME;
}

function parse(text: string): DeviceSettings {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) return EMPTY;
  const { printer, paper } = value as Record<string, unknown>;
  return { printer: isPrinterName(printer) ? printer : null, paper: paper ?? null };
}

export class DeviceSettingsFile {
  private readonly path: string;
  // Writes queue behind each other so two quick changes cannot interleave and lose one.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.path = join(dir, 'device-settings.json');
  }

  async read(): Promise<DeviceSettings> {
    await this.queue;
    try {
      return parse(await readFile(this.path, 'utf8'));
    } catch {
      // Not written yet, or damaged: start from nothing rather than refuse to print.
      return EMPTY;
    }
  }

  update(patch: Partial<DeviceSettings>): Promise<void> {
    const next = this.queue.then(async () => {
      let current = EMPTY;
      try {
        current = parse(await readFile(this.path, 'utf8'));
      } catch {
        // First write.
      }
      const temp = `${this.path}.tmp`;
      await writeFile(temp, JSON.stringify({ ...current, ...patch }));
      await rename(temp, this.path);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
