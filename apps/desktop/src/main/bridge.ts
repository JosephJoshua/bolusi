// What the preload hands the counter page as `window.bolusi`: a few narrow calls into the main
// process, nothing that reaches Node itself. Types only, shared by the preload and the renderer.

export interface PrinterInfo {
  /** The Windows printer name, which jobs are sent to. */
  readonly name: string;
  readonly displayName: string;
}

/** None chosen yet, the chosen one is gone (unplugged, renamed), or Windows refused the job. */
export type PrintProblem = 'noPrinter' | 'printerMissing' | 'failed';

export type PrintResult =
  { readonly ok: true } | { readonly ok: false; readonly problem: PrintProblem };

export interface PrinterSettings {
  /** null until someone picks one in Settings. */
  readonly printer: string | null;
  /** The paper as last saved, unchecked: the page validates it. */
  readonly paper: unknown;
}

export interface PrintersBridge {
  list(): Promise<readonly PrinterInfo[]>;
  settings(): Promise<PrinterSettings>;
  choose(printer: string | null): Promise<void>;
  setPaper(paper: { readonly widthMm: number; readonly heightMm: number }): Promise<void>;
  /** ESC/P bytes as one RAW job on the chosen printer. */
  printRaw(bytes: Uint8Array, jobName: string): Promise<PrintResult>;
  /** An HTML page on the chosen printer, without a dialog. */
  printPage(
    html: string,
    paper: { readonly widthMm: number; readonly heightMm: number },
  ): Promise<PrintResult>;
}

export type UpdateState =
  | { readonly kind: 'none' }
  | { readonly kind: 'downloading' }
  | { readonly kind: 'ready'; readonly version: string };

export interface UpdatesBridge {
  /** The installed version, as Settings shows it. */
  version(): Promise<string>;
  state(): Promise<UpdateState>;
  /** Calls back on every change; returns the unsubscribe. */
  onChange(listener: (state: UpdateState) => void): () => void;
  /** Restart into the downloaded version. */
  install(): Promise<void>;
}

export interface DesktopBridge {
  readonly printers: PrintersBridge;
  readonly updates: UpdatesBridge;
}
