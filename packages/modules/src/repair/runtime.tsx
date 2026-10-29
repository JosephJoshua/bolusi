// The repair screens' runtime port (04 §7), the same pattern as notes: screens (phone and counter PC) read and write
// through a small typed port the platform binds, never the database or the op log. The commands and
// queries come straight from the module through `ModulePort`, so a new command needs no new wiring.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ModulePort, PaperSettings, PrintDocument } from '@bolusi/core';

import type { IntakeOptionSettings } from './intake-options.js';
import type { DeviceModelPhoto } from './device-models.js';
import type { CancelFees, PrintSettings } from './queries.js';
import type { InventoryRuntime } from '../inventory/runtime.js';
import type { MoneyPort, MoneyRuntime } from '../money/runtime.js';
import { CASH_ACCOUNT } from '../money/constants.js';
import type { PaymentAccountRow } from '../money/queries.js';
import type { HandoverQris } from './handover-payment.js';
import { REPAIR_DOCUMENT_KIND } from './money-document.js';
import type { repairModule } from './manifest.js';
import {
  createRuntimeContext,
  useLiveQuery,
  useThumbnailState,
  type EntitySyncStatuses,
  type LiveSource,
  type PhotoCapture,
  type QueryState,
  type SignatureCapture,
  type ThumbnailLoader,
  type ThumbnailRef,
  type ThumbnailState,
  type VideoCapture,
  type VideoMediaRef,
  type VideoPlayback,
} from '../screen-kit/index.js';

/**
 * A slip ready to leave the app: a self-contained HTML page for paper of this size, and the document
 * it was drawn from, for a printer that takes text (a dot-matrix gets it as ESC/P).
 */
export interface SlipOutput {
  readonly html: string;
  readonly document: PrintDocument;
  /** Names the print job and the PDF file. */
  readonly jobName: string;
  readonly paper: PaperSettings;
}

/** Why a print did not go out: no printer picked yet, the picked one is gone, or it refused the job. */
export type PrinterProblemReason = 'noPrinter' | 'printerMissing' | 'failed';

/** Thrown by `RepairPrinting.output` when the job did not reach the printer. */
export class PrinterProblem extends Error {
  override readonly name = 'PrinterProblem';
  constructor(readonly reason: PrinterProblemReason) {
    super(`print: ${reason}`);
  }
}

/** A printer installed on this device, as its system names it. */
export interface DevicePrinter {
  /** The system's own name, which jobs are sent to. */
  readonly name: string;
  readonly label: string;
}

/**
 * The printers of a device that sends slips straight to one (the counter PC). Picked once in
 * Settings, like the paper; a phone has none of this and prints through the system dialog.
 */
export interface DevicePrinters {
  list(): Promise<readonly DevicePrinter[]>;
  /** The chosen printer's name; null before anyone picks one. */
  chosen(): Promise<string | null>;
  choose(name: string): Promise<void>;
}

/** Decoded pixels of a picture, for turning a logo into dot-matrix dots. */
export interface DecodedImage {
  readonly rgba: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * What printing a slip needs from the platform (core `print`). The phone prints through the system
 * dialog or shares a PDF; the counter PC prints on its chosen printer, in text mode on a dot-matrix.
 */
export interface RepairPrinting {
  /** The store's name as enrolled, printed when the owner has not set another. */
  storeName(): Promise<string>;
  /** Who is signed in, printed as who printed the slip. */
  userName(): Promise<string | null>;
  /** The paper this device last printed on; null before the first print. */
  readPaper(): Promise<PaperSettings | null>;
  writePaper(paper: PaperSettings): Promise<void>;
  /**
   * Hand the page to the system print dialog or the chosen printer, or share it as a PDF. A failure
   * rejects, with `PrinterProblem` when the printer is the reason. `unconfirmed` is a dialog that
   * cannot say whether it printed (Android): the screen asks.
   */
  output(slip: SlipOutput, how: 'print' | 'share'): Promise<'done' | 'cancelled' | 'unconfirmed'>;
  /** A verified picture (the logo, a signature) as a `data:` URI; null when it is not here yet. */
  imageDataUri(ref: ThumbnailRef): Promise<string | null>;
  /** Present where slips go straight to a printer picked in Settings. */
  readonly printers?: DevicePrinters | undefined;
  /**
   * Pixels of a `data:` URI picture; present where a dot-matrix can print the store's logo. Null
   * when it cannot be decoded, and the slip prints without it.
   */
  readonly decodeImage?: ((dataUri: string) => Promise<DecodedImage | null>) | undefined;
}

/** A colleague who can work repairs here, for the "assign to" picker. */
export interface RepairTechnician {
  readonly id: string;
  readonly name: string;
}

export interface RepairRuntime extends ModulePort<typeof repairModule>, LiveSource {
  /** The money ledger: payment methods, a servisan's payments, and taking money at handover. */
  readonly money: MoneyPort;
  /** Op sync statuses per ticket id (design-system §3.5); an absent ticket is all-synced. */
  ticketSyncStatuses(ticketIds: readonly string[]): Promise<EntitySyncStatuses>;
  /** Active colleagues who hold `repair.work` in this store, by name. */
  technicians(): Promise<readonly RepairTechnician[]>;
  readonly capturePhoto: PhotoCapture;
  readonly captureSignature: SignatureCapture;
  readonly loadThumbnail: ThumbnailLoader;
  /**
   * A catalog photo of a phone model, downloaded the first time it is shown and cached. Resolves
   * null when it cannot be had now (offline, not on the server): the screen shows no picture.
   */
  readonly loadModelPhoto: (photo: DeviceModelPhoto) => Promise<string | null>;
  /**
   * Hand one photo to the platform to save or send (the share sheet on a phone, a download on the
   * web). Absent ⇒ this build cannot, and the photo viewer shows no share button.
   */
  readonly sharePhoto?: ((ref: ThumbnailRef) => Promise<'done' | 'failed'>) | undefined;
  /** Record the customer's ownership video. Absent ⇒ this device cannot (a PC with no webcam). */
  readonly recordVideo?: VideoCapture | undefined;
  /** Play a stored clip. Absent ⇒ this build cannot, and the clip shows without a play button. */
  readonly playVideo?: VideoPlayback | undefined;
  /** Whether a clip taken here is still kept: a restored intake draft can outlive its video. */
  readonly videoKept?: ((ref: VideoMediaRef) => Promise<boolean>) | undefined;
  /** Pick a picture from the device's gallery (the store logo). Absent ⇒ this build cannot. */
  readonly pickPhoto?: PhotoCapture | undefined;
  /** Absent ⇒ this build cannot print, and no print action shows. */
  readonly printing?: RepairPrinting | undefined;
  /** The parts a servisan draws on. Absent ⇒ this build has no stock, and no parts section shows. */
  readonly inventory?: InventoryRuntime | undefined;
  /** The app's client diagnostics log (`@bolusi/device` `consoleDiagnostics`), for what fails quietly. */
  readonly diagnostics: RepairDiagnostics;
}

/** Where a failure that the screen carries on past is written down. */
export interface RepairDiagnostics {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const RepairRuntimeContext = createRuntimeContext<RepairRuntime>('repair');

export function RepairRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: RepairRuntime;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <RepairRuntimeContext.Provider runtime={runtime}>{children}</RepairRuntimeContext.Provider>
  );
}

export const useRepairRuntime = RepairRuntimeContext.useRuntime;

/** A repair read kept live across local and pulled changes (04 §7). */
export function useRepairQuery<TData>(
  run: (runtime: RepairRuntime) => Promise<TData>,
  key: string,
): QueryState<TData> {
  return useLiveQuery(useRepairRuntime(), run, key);
}

export function useRepairThumbnail(ref: ThumbnailRef | null): ThumbnailState {
  return useThumbnailState(useRepairRuntime().loadThumbnail, ref);
}

/** This store's cancellation fees; `reloadKey` re-reads them after a failed load. */
export function useCancelFees(reloadKey = 0): QueryState<CancelFees> {
  return useRepairQuery(
    async (rt) => (await rt.query('cancelFees', {})).rows[0]!,
    `cancelFees:${String(reloadKey)}`,
  );
}

/** What this store's slips print besides the servisan; `reloadKey` re-reads after a failed load. */
export function usePrintSettings(reloadKey = 0): QueryState<PrintSettings> {
  return useRepairQuery(
    async (rt) => (await rt.query('printSettings', {})).rows[0]!,
    `printSettings:${String(reloadKey)}`,
  );
}

/** After how many days this store flags a phone nobody collected; `reloadKey` re-reads after a failure. */
export function useUncollectedLimit(reloadKey = 0): QueryState<{ readonly days: number }> {
  return useRepairQuery(
    async (rt) => (await rt.query('uncollectedDays', {})).rows[0]!,
    `uncollectedDays:${String(reloadKey)}`,
  );
}

/**
 * The name customers know this store by, for a message to them: the slips' header name, else the
 * store's enrolled name. Null while it loads, or when this build knows neither.
 */
export function useStoreDisplayName(): string | null {
  const name = useRepairQuery(
    async (rt) =>
      (await rt.query('printSettings', {})).rows[0]!.name ??
      (await rt.printing?.storeName()) ??
      null,
    'storeDisplayName',
  );
  return name.status === 'ready' ? name.data : null;
}

/** The enrolled store's name, which slips print while the owner leaves theirs empty. */
export function usePrintStoreName(): string {
  const printing = useRepairRuntime().printing;
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    void printing?.storeName().then((loaded) => {
      if (live) setName(loaded);
    });
    return () => {
      live = false;
    };
  }, [printing]);
  return name;
}

/** The franchise's intake lists and this store's hidden items, kept live as either syncs in. */
export function useIntakeOptionSettings(reloadKey = 0): QueryState<IntakeOptionSettings> {
  return useRepairQuery(
    async (rt) => (await rt.query('intakeOptionSettings', {})).rows[0]!,
    `intakeOptionSettings:${String(reloadKey)}`,
  );
}

const NO_ACCOUNTS: readonly PaymentAccountRow[] = [];

/**
 * The store's payment methods besides cash, live; null while they load, so a method picked before
 * (a restored draft's) is not taken for cash. If they cannot be read, cash stands alone.
 */
export function usePaymentAccounts(): readonly PaymentAccountRow[] | null {
  const accounts = useRepairQuery(
    async (rt) => (await rt.money.query('paymentAccounts', {})).rows,
    'paymentAccounts',
  );
  if (accounts.status === 'ready') return accounts.data;
  return accounts.status === 'error' ? NO_ACCOUNTS : null;
}

/**
 * QRIS at a servisan's handover: the port, the servisan as the ledger names it (null until its
 * number is known), and the ids of the payments the ledger already holds for it, so a QR payment
 * that synced in is no longer counted as on its way.
 */
export function useTicketQris(ticketId: string, ticketNumber: string | null): HandoverQris {
  const runtime = useRepairRuntime();
  const entries = useRepairQuery(
    async (rt) =>
      (await rt.money.query('documentMoney', { kind: REPAIR_DOCUMENT_KIND, id: ticketId })).rows[0]
        ?.entries ?? [],
    `documentMoney:${ticketId}`,
  );
  const recorded = useMemo(
    () => (entries.status === 'ready' ? new Set(entries.data.map((entry) => entry.id)) : null),
    [entries],
  );
  return {
    port: runtime.money.qris,
    document:
      ticketNumber === null
        ? null
        : { kind: REPAIR_DOCUMENT_KIND, id: ticketId, label: ticketNumber },
    recorded,
    newId: () => runtime.money.newId(),
  };
}

export interface PaymentMethodChoice {
  readonly account: string;
  readonly reference: string;
}

/**
 * The method a down payment step records through: cash for a new DP; for a correction, the one the
 * DP came in by, until the owner picks another.
 */
export function useDownPaymentMethod(
  ticketId: string,
  mode: 'record' | 'correct',
): readonly [PaymentMethodChoice, (method: PaymentMethodChoice) => void] {
  const [picked, setPicked] = useState<PaymentMethodChoice | null>(null);
  const original = useRepairQuery(async (rt): Promise<PaymentMethodChoice | null> => {
    if (mode === 'record') return null;
    const money = (
      await rt.money.query('documentMoney', { kind: REPAIR_DOCUMENT_KIND, id: ticketId })
    ).rows[0];
    const first = money?.entries.find(
      (entry) => entry.kind === 'payment_received' && entry.voidedAt === null,
    );
    return first?.account == null
      ? null
      : { account: first.account, reference: first.reference ?? '' };
  }, `downPaymentMethod:${ticketId}:${mode}`);
  const fallback = original.status === 'ready' ? original.data : null;
  return [picked ?? fallback ?? { account: CASH_ACCOUNT, reference: '' }, setPicked];
}

/** A model photo's uri once loaded; null while loading or when there is none to show. */
/**
 * Who each servisan is for, by id: the Kas lists name the customer, not only the servisan number
 * money records carry (their labels never hold a name). Someone who cannot read repairs gets none.
 */
export async function servisanCustomers(
  port: ModulePort<typeof repairModule>,
  documents: readonly { readonly kind: string; readonly id: string }[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [
    ...new Set(documents.filter((d) => d.kind === REPAIR_DOCUMENT_KIND).map((d) => d.id)),
  ];
  const names = new Map<string, string>();
  for (let start = 0; start < ids.length; start += SERVISAN_PAGE) {
    const page = ids.slice(start, start + SERVISAN_PAGE);
    const result = await port
      .query('listTickets', { filter: { ids: page }, limit: page.length })
      .catch(() => null);
    if (result === null) return names;
    for (const row of result.rows) names.set(row.id, row.customerName);
  }
  return names;
}
const SERVISAN_PAGE = 100;

/**
 * The ledger as the Kas screens read it, from a repair runtime: its money port, live on the same
 * change feed, naming each servisan's customer. `nameOf` names a colleague ("counted by").
 */
export function moneyRuntimeOf(
  repair: RepairRuntime,
  nameOf: (userId: string) => string | null,
): MoneyRuntime {
  return {
    ...repair.money,
    subscribe: repair.subscribe,
    nameOf,
    customersOf: (documents) => servisanCustomers(repair, documents),
  };
}

export function useModelPhoto(photo: DeviceModelPhoto | null): string | null {
  const load = useRepairRuntime().loadModelPhoto;
  const loadRef = useRef(load);
  loadRef.current = load;
  const key = photo === null ? null : `${photo.modelId}:${photo.sha256}`;
  const [loaded, setLoaded] = useState<{ key: string; uri: string | null } | null>(null);
  useEffect(() => {
    if (photo === null || key === null) return;
    let active = true;
    loadRef.current(photo).then(
      (uri) => {
        if (active) setLoaded({ key, uri });
      },
      () => {
        if (active) setLoaded({ key, uri: null });
      },
    );
    return () => {
      active = false;
    };
    // The key is the photo's identity; a new object for the same photo must not reload it.
  }, [key]);
  return loaded !== null && loaded.key === key ? loaded.uri : null;
}
