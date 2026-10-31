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
  /** A dialog is open on the counter, so a quiet-time update must wait. */
  busy(busy: boolean): void;
}

/** The window around the page, as far as the title bar needs it. */
export interface WindowBridge {
  /** F11 hides Windows' caption buttons, so the bar stops leaving room for them. */
  fullscreen(): Promise<boolean>;
  /** Calls back on every change; returns the unsubscribe. */
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
}

/** Whether the app opens by itself when someone signs in to Windows. */
export interface StartupBridge {
  /** Null where the system has no such setting (a build run from source, not on Windows). */
  get(): Promise<boolean | null>;
  set(open: boolean): Promise<void>;
}

/** A camera or microphone as Chromium lists it; the label finds it again under a new id. */
export interface MediaInputChoice {
  readonly deviceId: string;
  readonly label: string;
}

export interface MediaChoices {
  /** Null: the first one Windows lists. */
  readonly camera: MediaInputChoice | null;
  readonly microphone: MediaInputChoice | null;
}

/** The camera and microphone this PC's photos and videos use. */
export interface MediaBridge {
  choices(): Promise<MediaChoices>;
  choose(kind: 'camera' | 'microphone', choice: MediaInputChoice | null): Promise<void>;
}

export interface DesktopBridge {
  readonly printers: PrintersBridge;
  readonly media: MediaBridge;
  readonly updates: UpdatesBridge;
  readonly window: WindowBridge;
  readonly startup: StartupBridge;
  readonly core: CoreBridge;
}

/** The offline core's door: ask main for a port to it (on every page load, so a reload reconnects). */
export interface CoreBridge {
  connect(): void;
}

/** Main's answer, posted to the page's own window with the port attached. */
export const CORE_PORT_MESSAGE = 'bolusi:core-port';

/** `live`: a port to the core is attached; `demo`: run the seeded demo; `unavailable`: the core is down. */
export type CorePortMode = 'live' | 'demo' | 'unavailable';
