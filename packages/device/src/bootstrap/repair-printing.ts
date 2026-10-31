/**
 * The phone's half of slip printing (the repair screens' `RepairPrinting` port): names read from
 * this device, the paper it last printed on, verified pictures as `data:` URIs, and the page handed
 * to the platform. Node-safe: the print dialog, PDF writer and file reads arrive as a port.
 */
import {
  readMeta,
  STORE_NAME_META_KEY,
  writeMeta,
  zPaperSettings,
  type PaperSettings,
} from '@bolusi/core';
import type { RepairPrinting, SlipOutput } from '@bolusi/modules/repair/screens';
import type { ThumbnailLoader } from '@bolusi/modules/screen-kit';
import type { Kysely } from 'kysely';

/** Device-local: each phone remembers the paper it prints on. */
export const PRINT_PAPER_META_KEY = 'print.paper';

/** The native half: expo-print's dialog and PDF writer, the share sheet, and file reads. */
export interface PrintPlatform {
  /** The system print dialog: 'unconfirmed' where it cannot say whether it printed (Android). */
  print(slip: SlipOutput): Promise<'done' | 'cancelled' | 'unconfirmed'>;
  /** Write the page as a PDF named after the job and open the share sheet. */
  sharePdf(slip: SlipOutput): Promise<'done' | 'cancelled'>;
  readBase64(uri: string): Promise<string>;
}

export function createRepairPrinting<DB>(deps: {
  readonly db: Kysely<DB>;
  readonly loadThumbnail: ThumbnailLoader;
  readonly platform: PrintPlatform;
}): RepairPrinting {
  return {
    storeName: async () => (await readMeta(deps.db, STORE_NAME_META_KEY)) ?? '',
    async readPaper(): Promise<PaperSettings | null> {
      const saved = await readMeta(deps.db, PRINT_PAPER_META_KEY);
      if (saved === null) return null;
      try {
        const parsed = zPaperSettings.safeParse(JSON.parse(saved));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    writePaper: (paper) => writeMeta(deps.db, PRINT_PAPER_META_KEY, JSON.stringify(paper)),
    output: (slip, how) =>
      how === 'print' ? deps.platform.print(slip) : deps.platform.sharePdf(slip),
    async imageDataUri(ref) {
      const state = await deps.loadThumbnail(ref).catch(() => ({ kind: 'unavailable' }) as const);
      if (state.kind !== 'ready') return null;
      const mime = ref.kind === 'signed' ? ref.mime : 'image/jpeg';
      return `data:${mime};base64,${await deps.platform.readBase64(state.uri)}`;
    },
  };
}
