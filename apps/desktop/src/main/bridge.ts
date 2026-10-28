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

export type HandoffKind = 'photo' | 'signature';

/** The copy on the page the phone opens, in the counter's language. */
export interface HandoffPageLabels {
  readonly title: string;
  readonly hint: string;
  readonly take: string;
  readonly retake: string;
  readonly clear: string;
  readonly send: string;
  readonly sending: string;
  readonly sent: string;
  readonly failed: string;
  readonly expired: string;
  readonly unreadable: string;
}

export type HandoffOpened =
  | { readonly ok: true; readonly id: string; readonly urls: readonly string[] }
  /** No store network to offer the page on, or the port would not open. */
  | { readonly ok: false; readonly problem: 'noNetwork' | 'failed' };

export type HandoffEvent =
  | { readonly id: string; readonly type: 'opened' | 'expired' }
  | { readonly id: string; readonly type: 'photo'; readonly bytes: Uint8Array }
  | {
      readonly id: string;
      readonly type: 'signature';
      readonly strokes: readonly (readonly { readonly x: number; readonly y: number }[])[];
      readonly pad: { readonly width: number; readonly height: number };
    };

export interface HandoffBridge {
  /** Starts waiting for one photo or signature from a phone; a new open replaces the last. */
  open(kind: HandoffKind, labels: HandoffPageLabels): Promise<HandoffOpened>;
  cancel(id: string): Promise<void>;
  /** Calls back when the phone opens the page, sends, or the code expires. */
  onEvent(listener: (event: HandoffEvent) => void): () => void;
}

export interface DesktopBridge {
  readonly printers: PrintersBridge;
  readonly updates: UpdatesBridge;
  readonly handoff: HandoffBridge;
}
