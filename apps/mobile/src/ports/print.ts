// The print binding for `PrintPlatform`: expo-print's system dialog and PDF writer, and the share
// sheet. Native only; the decisions (names, paper, pictures) live in bootstrap/repair-printing.ts.
import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { PrintPlatform } from '@bolusi/device/bootstrap/repair-printing';
import type { SlipOutput } from '@bolusi/modules/repair/screens';

/** expo-print sizes the page in points (72 per inch). The HTML's own @page rule matches it. */
function pageSize(slip: SlipOutput): { width: number; height: number } {
  const points = (mm: number): number => Math.round((mm / 25.4) * 72);
  return { width: points(slip.paper.widthMm), height: points(slip.paper.heightMm) };
}

/** iOS rejects with this code when the person closes the dialog without printing. */
const PRINT_INCOMPLETE = 'ERR_PRINT_INCOMPLETE';

function slipsDirectory(): Directory {
  const dir = new Directory(Paths.cache, 'slips');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export const expoPrintPlatform: PrintPlatform = {
  async print(slip) {
    const size = pageSize(slip);
    try {
      await Print.printAsync({
        html: slip.html,
        ...size,
        orientation:
          size.width > size.height ? Print.Orientation.landscape : Print.Orientation.portrait,
      });
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
      (await Print.printToFileAsync({ html: slip.html, ...pageSize(slip) })).uri,
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
