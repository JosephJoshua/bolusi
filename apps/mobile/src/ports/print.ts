// The print binding for `PrintPlatform`: expo-print's system dialog and PDF writer, and the share
// sheet. Native only; the decisions (names, paper, pictures) live in bootstrap/repair-printing.ts.
import { requireNativeModule } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { PrintPlatform } from '@bolusi/device/bootstrap/repair-printing';
import { PrinterProblem, type SlipOutput } from '@bolusi/modules/repair/screens';

/**
 * expo-print sizes the page in points (72 per inch). The HTML's own @page rule matches it. iOS
 * picks the printer's paper from the PDF's page; Android's dialog opens on it only through our
 * patch (patches/expo-print@57.0.2.patch), since stock expo-print leaves it on the locale default.
 * expo-print ships a prebuilt Android library, so package.json's expo.autolinking builds it from
 * the patched source instead.
 */
function pageSize(slip: SlipOutput): { width: number; height: number } {
  const points = (mm: number): number => Math.round((mm / 25.4) * 72);
  return { width: points(slip.paper.widthMm), height: points(slip.paper.heightMm) };
}

/** iOS rejects with this code when the person closes the dialog without printing. */
const PRINT_INCOMPLETE = 'ERR_PRINT_INCOMPLETE';

/**
 * How long the page may take to become a PDF, or on Android to reach its print dialog (the call
 * returns once the dialog is launched). Longer means the system's call hung: it is abandoned so
 * the next tap works, and a late answer is ignored.
 */
export const PRINT_READY_TIMEOUT_MS = 15_000;

function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PrinterProblem('stuck')), PRINT_READY_TIMEOUT_MS);
  });
  return Promise.race([work, stuck]).finally(() => clearTimeout(timer));
}

/**
 * The native print call, without `Print.printAsync`'s wrapper: that wrapper refuses every print
 * while one is pending, so a single call that never settles stopped all printing until restart.
 * The screen already ignores a second tap while one runs.
 */
interface ExpoPrintModule {
  print(options: Print.PrintOptions): Promise<void>;
}

function slipsDirectory(): Directory {
  const dir = new Directory(Paths.cache, 'slips');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export const expoPrintPlatform: PrintPlatform = {
  async print(slip) {
    const size = pageSize(slip);
    const dialog = requireNativeModule<ExpoPrintModule>('ExpoPrint').print({
      html: slip.html,
      ...size,
      orientation:
        size.width > size.height ? Print.Orientation.landscape : Print.Orientation.portrait,
    });
    try {
      // iOS answers when its dialog closes, however long the person takes, so only Android's call
      // has a deadline. iOS's own hang (its dialog failing to show) rejects through our patch.
      await (Platform.OS === 'android' ? within(dialog) : dialog);
      // Android hands the job to its print service and never says whether it was cancelled there,
      // so the screen asks rather than counting a cancelled first print as printed.
      return Platform.OS === 'android' ? 'unconfirmed' : 'done';
    } catch (error) {
      if ((error as { code?: unknown }).code === PRINT_INCOMPLETE) return 'cancelled';
      throw error;
    }
  },
  async sharePdf(slip) {
    if (!(await Sharing.isAvailableAsync())) throw new Error('sharing is not available');
    const written = new File(
      (await within(Print.printToFileAsync({ html: slip.html, ...pageSize(slip) }))).uri,
    );
    // Named after the job so the customer's WhatsApp shows "Nota servisan SV-0123.pdf", not a uuid.
    const named = new File(slipsDirectory(), `${slip.jobName.replace(/[\\/:*?"<>|]/g, '-')}.pdf`);
    if (named.exists) named.delete();
    await written.move(named);
    await Sharing.shareAsync(named.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    return 'done';
  },
  readBase64: (uri) => new File(uri).base64(),
};
