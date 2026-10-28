// The QRIS-through-Xendit state the phone's and the PC's screens share (qris.ts): which methods show
// a QR at payment, the QR that is open and whether it is paid, and connecting a method in
// "Metode pembayaran". The screens only draw it.
//
// A QR payment is recorded by the server, not by this device, and reaches it by sync a moment
// later. Until then the screen subtracts it from what is due (`pending`), so nobody takes the same
// money twice, and a step that checks the ledger (the handover) waits for it.
import { formatMoney } from '@bolusi/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  QRIS_MIN_AMOUNT,
  type QrisCharge,
  type QrisChargeBody,
  type QrisConnection,
  zQrisConnectBody,
} from '@bolusi/schemas';

import type { MoneyDocument } from './documents.js';
import { tm } from './i18n.js';
import { rupiah, type PaymentLine } from './payment-entry.js';
import { qrisFailure, type QrisFailure, type QrisPort } from './qris.js';

/** How often an open QR asks whether it is paid; the server reads Xendit at most every 4 s. */
export const QRIS_POLL_MS = 3_000;

const ACCOUNT_PREFIX = 'account:';

// ── the QRs this device showed, for as long as the app runs ─────────────────────────────────────
//
// A QR the customer may have scanned can be paid after its screen closed, its line switched to
// another method, or the counter gave up on it. So every QR shown is kept here by document, outside
// any screen, and a payment screen opened again keeps counting it (and checking on it) until the
// ledger here holds its payment. One list for the device, whoever is signed in: the money is the
// document's, and a port is made again on every sign-in and permission change.

interface Shown {
  readonly documentId: string;
  readonly charge: QrisCharge;
}

const shownQrs = new Map<string, Shown>();
const listeners = new Set<() => void>();

/** Remember a QR's latest status; a paid one never goes back to waiting. */
function remember(documentId: string, charge: QrisCharge): void {
  if (shownQrs.get(charge.id)?.charge.status === 'paid') return;
  shownQrs.set(charge.id, { documentId, charge });
  for (const listener of listeners) listener();
}

function shownFor(documentId: string | undefined): QrisCharge[] {
  if (documentId === undefined) return [];
  return [...shownQrs.values()]
    .filter((shown) => shown.documentId === documentId)
    .map((shown) => shown.charge);
}

/** Forget every QR shown: for a device whose data is wiped, and between tests over fresh demo data. */
export function forgetShownQrs(): void {
  shownQrs.clear();
  for (const listener of listeners) listener();
}

/** Paid by QR for the document but not yet in this device's ledger (`recorded`, by entry id). */
/** The warning for QRs shown earlier and not paid yet; null when there are none. */
export function unresolvedText(unresolved: readonly number[]): string | null {
  if (unresolved.length === 0) return null;
  return unresolved.length === 1
    ? tm('money.qris.unresolved', { amount: formatMoney(unresolved[0]!) })
    : tm('money.qris.unresolvedMany', { count: unresolved.length });
}

export function pendingQrPayments(
  documentId: string | undefined,
  recorded: ReadonlySet<string> | null,
): number {
  return shownFor(documentId)
    .filter((charge) => charge.status === 'paid' && recorded?.has(charge.id) !== true)
    .reduce((sum, charge) => sum + charge.amount, 0);
}

/** Re-render when any shown QR changes. */
function useShownQrs(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = (): void => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

export interface QrisCheckoutInput {
  readonly port: QrisPort | undefined;
  /** What is being paid; null while it loads. */
  readonly document: MoneyDocument | null;
  /** The lines as the counter typed them. */
  readonly lines: readonly PaymentLine[];
  readonly setLines: (lines: readonly PaymentLine[]) => void;
  /** The ids of the payments this device's ledger holds for the document; null while they load. */
  readonly recorded: ReadonlySet<string> | null;
  readonly newId: () => string;
}

export interface OpenQr {
  /** The line the QR is for. */
  readonly key: string;
  readonly body: QrisChargeBody;
}

export interface QrisCheckout {
  /** The methods (`account:<id>`) whose lines are paid by showing a QR. */
  readonly qrAccounts: ReadonlySet<string>;
  /** The lines still to settle: one whose QR is paid is gone. */
  readonly lines: readonly PaymentLine[];
  /** Paid by QR but not yet in this device's ledger: less is due by that much. */
  readonly pending: number;
  /** Paid by QR for this document since the app started, synced in or not. */
  readonly received: number;
  /**
   * QRs shown earlier that are still payable but no longer on a line (they may yet be paid), each
   * by its amount: they are separate QRs, so never summed into one figure.
   */
  readonly unresolved: readonly number[];
  readonly open: OpenQr | null;
  /** Show the line's QR: the one already made for its amount, or a new one. */
  readonly show: (key: string) => void;
  /** A new QR for the open line, after the last one expired. */
  readonly renew: () => void;
  readonly close: () => void;
  /** The open QR was paid. */
  readonly paid: (charge: QrisCharge) => void;
  /** Take the open line by hand instead (no connection, Xendit not answering). */
  readonly takeByHand: () => void;
  /** Back to the QR for a line taken by hand. */
  readonly useQr: (key: string) => void;
}

/** Whether a line's amount can be paid by QR. */
export function qrAmountOk(line: PaymentLine): boolean {
  const amount = rupiah(line.amount);
  return amount !== null && amount >= QRIS_MIN_AMOUNT;
}

export function useQrisCheckout({
  port,
  document,
  lines,
  setLines,
  recorded,
  newId,
}: QrisCheckoutInput): QrisCheckout {
  const connections = useQrisConnections(port);
  const [open, setOpen] = useState<OpenQr | null>(null);
  useShownQrs();
  const documentId = document?.id;
  const shown = shownFor(documentId);
  const paidIds = new Set(shown.filter((c) => c.status === 'paid').map((c) => c.id));
  const done = (id: string): boolean => paidIds.has(id) || recorded?.has(id) === true;

  const qrAccounts = useMemo(
    () =>
      new Set(
        (connections.status === 'ready' ? connections.connections : []).map(
          (connection) => `${ACCOUNT_PREFIX}${connection.accountId}`,
        ),
      ),
    [connections],
  );
  const visible = lines.filter((line) => line.qr === undefined || !done(line.qr.id));
  const pending = pendingQrPayments(documentId, recorded);
  const received = shown
    .filter((charge) => charge.status === 'paid')
    .reduce((sum, charge) => sum + charge.amount, 0);
  const onLines = new Set(visible.map((line) => line.qr?.id));
  // Shown and still payable, but not on screen now: checked on while this screen is open (the open
  // one checks itself). Payable until the server says it expired, whatever this device's clock says.
  const unseen = shown.filter((c) => c.status === 'waiting' && c.id !== open?.body.id);
  const unresolved = unseen.filter((c) => !onLines.has(c.id)).map((c) => c.amount);
  const strayKey = unseen.map((c) => c.id).join(',');
  useEffect(() => {
    if (port === undefined || documentId === undefined || strayKey === '') return;
    const ids = strayKey.split(',');
    const timer = setInterval(() => {
      for (const id of ids) {
        port.charge(id).then(
          (charge) => remember(documentId, charge),
          () => undefined,
        );
      }
    }, QRIS_POLL_MS);
    return () => clearInterval(timer);
  }, [port, documentId, strayKey]);

  const openFor = (line: PaymentLine, fresh: boolean): void => {
    const amount = rupiah(line.amount);
    if (document === null || amount === null || amount < QRIS_MIN_AMOUNT) return;
    if (!line.account.startsWith(ACCOUNT_PREFIX)) return;
    // The same QR again for the same amount: a customer may already have scanned it.
    const qr = !fresh && line.qr?.amount === amount ? line.qr : { id: newId(), amount };
    setLines(visible.map((other) => (other.key === line.key ? { ...other, qr } : other)));
    setOpen({
      key: line.key,
      body: {
        id: qr.id,
        accountId: line.account.slice(ACCOUNT_PREFIX.length),
        document,
        amount,
      },
    });
  };
  const lineOf = (key: string | undefined) => visible.find((line) => line.key === key);
  const patch = (key: string, change: Partial<PaymentLine>): void =>
    setLines(visible.map((line) => (line.key === key ? { ...line, ...change } : line)));

  return {
    qrAccounts,
    lines: visible,
    pending,
    received,
    unresolved,
    open,
    show: (key) => {
      const line = lineOf(key);
      if (line !== undefined) openFor(line, false);
    },
    renew: () => {
      const line = lineOf(open?.key);
      if (line !== undefined) openFor(line, true);
    },
    close: () => setOpen(null),
    paid: (charge) => {
      if (documentId !== undefined) remember(documentId, charge);
    },
    takeByHand: () => {
      if (open !== null) patch(open.key, { manual: true, qr: undefined });
      setOpen(null);
    },
    useQr: (key) => patch(key, { manual: false, reference: '' }),
  };
}

// ── one QR, until it is paid ───────────────────────────────────────────────────────────────────

export type QrisChargeState =
  | { readonly kind: 'creating' }
  | {
      readonly kind: 'waiting';
      readonly charge: QrisCharge;
      /** The last check did not get through; still trying. */
      readonly reconnecting: boolean;
    }
  | { readonly kind: 'paid'; readonly charge: QrisCharge }
  | { readonly kind: 'expired'; readonly charge: QrisCharge }
  | { readonly kind: 'failed'; readonly reason: QrisFailure };

export interface QrisChargeView {
  readonly state: QrisChargeState;
  /** Try making the QR again after a failure. */
  readonly retry: () => void;
  /** Test mode: have Xendit pay it. */
  readonly simulate: () => void;
  readonly simulating: boolean;
  /** Why the test payment did not go through. */
  readonly simulateFailure: QrisFailure | null;
}

/** Make the QR for `body` and follow it until it is paid or expires. */
export function useQrisCharge(
  port: QrisPort,
  body: QrisChargeBody,
  onPaid: (charge: QrisCharge) => void,
): QrisChargeView {
  const [state, setState] = useState<QrisChargeState>({ kind: 'creating' });
  const [attempt, setAttempt] = useState(0);
  const [simulating, setSimulating] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState<QrisFailure | null>(null);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;
  const bodyRef = useRef(body);
  bodyRef.current = body;
  // Set while this QR is followed, so a late answer for an earlier one is dropped.
  const apply = useRef<(charge: QrisCharge) => void>(() => undefined);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reported = false;
    const check = (): void => {
      timer = setTimeout(() => {
        port.charge(bodyRef.current.id).then(
          (charge) => apply.current(charge),
          () => {
            if (!live) return;
            setState((current) =>
              current.kind === 'waiting' ? { ...current, reconnecting: true } : current,
            );
            check();
          },
        );
      }, QRIS_POLL_MS);
    };
    let settled = false;
    apply.current = (charge) => {
      if (!live || charge.id !== bodyRef.current.id || settled) return;
      remember(bodyRef.current.document.id, charge);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (charge.status === 'paid') {
        settled = true;
        setState({ kind: 'paid', charge });
        if (!reported) {
          reported = true;
          onPaidRef.current(charge);
        }
      } else if (charge.status === 'expired') {
        settled = true;
        setState({ kind: 'expired', charge });
      } else {
        setState({ kind: 'waiting', charge, reconnecting: false });
        check();
      }
    };
    setState({ kind: 'creating' });
    setSimulateFailure(null);
    port.createCharge(bodyRef.current).then(
      (charge) => apply.current(charge),
      (error: unknown) => {
        if (live) setState({ kind: 'failed', reason: qrisFailure(error) });
      },
    );
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [port, body.id, attempt]);

  const simulate = useCallback((): void => {
    if (simulating) return;
    setSimulating(true);
    setSimulateFailure(null);
    port
      .simulate(bodyRef.current.id)
      .then(
        (charge) => apply.current(charge),
        (error: unknown) => setSimulateFailure(qrisFailure(error)),
      )
      .finally(() => setSimulating(false));
  }, [port, simulating]);

  return {
    state,
    retry: () => setAttempt((n) => n + 1),
    simulate,
    simulating,
    simulateFailure,
  };
}

// ── connecting a method ────────────────────────────────────────────────────────────────────────

export type QrisConnectionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly connections: readonly QrisConnection[] }
  | { readonly status: 'failed'; readonly reason: QrisFailure };

/** The methods connected to Xendit, as the server says; none without a port. */
function useQrisConnections(port: QrisPort | undefined, nonce = 0): QrisConnectionsState {
  const [state, setState] = useState<QrisConnectionsState>(
    port === undefined ? { status: 'ready', connections: [] } : { status: 'loading' },
  );
  useEffect(() => {
    if (port === undefined) return;
    let live = true;
    setState({ status: 'loading' });
    port.connections().then(
      (connections) => {
        if (live) setState({ status: 'ready', connections });
      },
      (error: unknown) => {
        if (live) setState({ status: 'failed', reason: qrisFailure(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [port, nonce]);
  return state;
}

export interface QrisConnectionControl {
  readonly state: QrisConnectionsState;
  /** This method's connection, once loaded. */
  readonly connection: QrisConnection | null;
  readonly reload: () => void;
  readonly secretKey: string;
  readonly setSecretKey: (key: string) => void;
  /** The key typed looks like one. */
  readonly keyTyped: boolean;
  readonly busy: boolean;
  /** Why the last connect or disconnect did not go through. */
  readonly failure: QrisFailure | null;
  /** Resolves true once connected. */
  readonly connect: () => Promise<boolean>;
  readonly disconnect: () => Promise<boolean>;
}

/**
 * "Metode pembayaran": connect one QRIS method to Xendit with its secret key, or disconnect it.
 * Without a port (not a QRIS method, a device that cannot reach the server) it asks nothing.
 */
export function useQrisConnection(
  port: QrisPort | undefined,
  accountId: string,
): QrisConnectionControl {
  const [nonce, setNonce] = useState(0);
  const loaded = useQrisConnections(port, nonce);
  const [override, setOverride] = useState<{ readonly value: QrisConnection | null } | null>(null);
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  // Read at the click, so a second click before the re-render does not send it twice.
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<QrisFailure | null>(null);
  const fromServer =
    loaded.status === 'ready'
      ? (loaded.connections.find((connection) => connection.accountId === accountId) ?? null)
      : null;
  const connection = override === null ? fromServer : override.value;

  const act = async (call: () => Promise<QrisConnection | null>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      setOverride({ value: await call() });
      setSecretKey('');
      return true;
    } catch (error) {
      setFailure(qrisFailure(error));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return {
    state: loaded,
    connection,
    reload: () => {
      setOverride(null);
      setNonce((n) => n + 1);
    },
    secretKey,
    setSecretKey: (key) => {
      setSecretKey(key);
      setFailure(null);
    },
    keyTyped: zQrisConnectBody.safeParse({ secretKey }).success,
    busy,
    failure,
    connect: () =>
      port === undefined
        ? Promise.resolve(false)
        : act(() => port.connect(accountId, secretKey.trim())),
    disconnect: () =>
      port === undefined
        ? Promise.resolve(false)
        : act(async () => {
            await port.disconnect(accountId);
            return null;
          }),
  };
}
