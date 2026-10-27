// Printing in this build: the slip goes to the Windows print dialog through a hidden frame, so a
// counter prints on whatever printer the PC has. The dialog cannot say whether it printed, so the
// screen asks before the print counts. Raw ESC/P straight to a dot-matrix printer comes later.
import type { RepairPrinting } from '@bolusi/modules/repair/desktop';

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

/** The demo's printing, with the PC's store name and output. */
export function desktopPrinting(base: RepairPrinting, storeName: string): RepairPrinting {
  return {
    ...base,
    storeName: () => Promise.resolve(storeName),
    output: async (slip) => {
      await printHtml(slip.html);
      return 'unconfirmed';
    },
  };
}
