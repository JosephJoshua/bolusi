// This PC's own hardware settings: which printer the slips go to and the paper in it, and the
// camera and microphone photos and videos use. They describe the hardware on this desk, not the
// store's data, so they live in a small file beside the app rather than in the synced database,
// and survive signing in again or switching people.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A camera or microphone as Chromium lists it; the label finds it again under a new id. */
export interface MediaInputChoice {
  readonly deviceId: string;
  readonly label: string;
}

export interface DeviceSettings {
  /** The Windows printer name; null until someone picks one. */
  readonly printer: string | null;
  /** The paper as the renderer saved it; the renderer checks it on read. */
  readonly paper: unknown;
  /** Null: the first one Windows lists. */
  readonly camera: MediaInputChoice | null;
  readonly microphone: MediaInputChoice | null;
}

const EMPTY: DeviceSettings = { printer: null, paper: null, camera: null, microphone: null };
const MAX_PRINTER_NAME = 256;
const MAX_MEDIA_ID = 512;
const MAX_MEDIA_LABEL = 256;

export function isMediaInputChoice(value: unknown): value is MediaInputChoice {
  if (typeof value !== 'object' || value === null) return false;
  const { deviceId, label } = value as Record<string, unknown>;
  return (
    typeof deviceId === 'string' &&
    deviceId.length > 0 &&
    deviceId.length <= MAX_MEDIA_ID &&
    typeof label === 'string' &&
    label.length <= MAX_MEDIA_LABEL
  );
}

function mediaChoice(value: unknown): MediaInputChoice | null {
  return isMediaInputChoice(value) ? { deviceId: value.deviceId, label: value.label } : null;
}

export function isPrinterName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PRINTER_NAME;
}

function parse(text: string): DeviceSettings {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) return EMPTY;
  const { printer, paper, camera, microphone } = value as Record<string, unknown>;
  return {
    printer: isPrinterName(printer) ? printer : null,
    paper: paper ?? null,
    camera: mediaChoice(camera),
    microphone: mediaChoice(microphone),
  };
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
