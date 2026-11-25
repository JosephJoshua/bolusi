// The QRIS-through-Xendit state the phone's and the PC's screens share (qris.ts): which methods show
// a QR at payment, the QR that is open and whether it is paid, and connecting a method in
// "Metode pembayaran". The screens only draw it.
//
// A QR payment is recorded by the server, not by this device, and reaches it by sync a moment
// later. Until then the screen subtracts it from what is due (`pending`), so nobody takes the same
// money twice, and a step that checks the ledger (the handover) waits for it.
//
// ONE WAY AT A TIME. While the bill has a QR the customer can still pay, shown on this device or
// another one of the store (`openCharges`), the payment cannot be taken any other way (`blocking`,
// which the screens hand to `paymentEntry`): the counter cancels the QR first. Xendit cannot
// withdraw a QR, so cancelling asks the server, which asks Xendit whether it was already paid. With
// no connection the counter may still let it go on this device; a payment that comes anyway is
// recorded and shows in Kas as money to give back.
//
// The default: a new line on a bill starts on the store's QRIS through Xendit when one is
// connected and reachable (Joseph, 2026-11-25). Such a line can only be completed by the customer
// paying its QR, so a cash payment is never booked to it for want of a tap.
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
import { NO_METHOD, rupiah, type PaymentLine } from './payment-entry.js';
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

/** Statuses a QR does not leave: paid stays paid, cancelled only turns paid. */
function settledRank(status: QrisCharge['status']): number {
  return status === 'paid' ? 2 : status === 'cancelled' ? 1 : 0;
}

/** Remember a QR's latest status; a paid one never goes back to waiting, a cancelled one only pays. */
function remember(documentId: string, charge: QrisCharge): void {
  const known = shownQrs.get(charge.id)?.charge.status;
  if (known !== undefined && settledRank(known) > settledRank(charge.status)) return;
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

/** What a QR shown earlier, not paid and not on a line now, says above the payment. */
export function unresolvedText(amount: number): string {
  return tm('money.qris.unresolved', { amount: formatMoney(amount) });
}

/** Paid by QR for the document but not yet in this device's ledger (`recorded`, by entry id). */
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
  /**
   * The lines are still the screen's own first line, untouched by the counter: it starts on the
   * store's QRIS through Xendit when one is connected here.
   */
  readonly untouched?: boolean | undefined;
}

/** A QR shown earlier that is still payable and not on a line, with what cancelling it is doing. */
export interface StrayQr {
  readonly charge: QrisCharge;
  readonly cancelling: boolean;
  /** Cancelling did not get through: offline, or the server did not answer. */
  readonly cancelFailed: boolean;
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
   * QRs shown earlier (here or on another device of the store) that are still payable but not on a
   * line: each is cancelled on its own, never summed into one figure.
   */
  readonly unresolved: readonly StrayQr[];
  /**
   * How many QRs for the bill the customer can still pay, on a line or not: while there is one, the
   * payment cannot be taken another way (pass it to `paymentEntry`).
   */
  readonly blocking: number;
  /** Cancel a QR shown earlier, to take the bill another way. */
  readonly cancel: (id: string) => void;
  /**
   * Let a QR go on this device only, when cancelling could not reach the server: a payment that
   * still comes is recorded as money to give back.
   */
  readonly letGo: (id: string) => void;
  readonly open: OpenQr | null;
  /** Show the line's QR: the one already made for its amount, or a new one. */
  readonly show: (key: string) => void;
  /** A new QR for the open line, after the last one expired. */
  readonly renew: () => void;
  readonly close: () => void;
  /** The open QR was paid. */
  readonly paid: (charge: QrisCharge) => void;
  /** Cancel the QR open now and close it. */
  readonly cancelOpen: () => void;
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
  untouched = false,
}: QrisCheckoutInput): QrisCheckout {
  const connections = useQrisConnections(port);
  const [open, setOpen] = useState<OpenQr | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const [cancelFailed, setCancelFailed] = useState<ReadonlySet<string>>(new Set());
  const [openNonce, setOpenNonce] = useState(0);
  useShownQrs();
  const documentId = document?.id;
  const shown = shownFor(documentId);
  const paidIds = new Set(shown.filter((c) => c.status === 'paid').map((c) => c.id));
  const done = (id: string): boolean => paidIds.has(id) || recorded?.has(id) === true;
  // Neither paid nor given up on: the customer may yet pay it.
  const gone = (id: string): boolean =>
    done(id) || shown.some((c) => c.id === id && c.status !== 'waiting');

  // A QR another device of the store showed for this bill, or this one before a restart.
  useEffect(() => {
    if (port === undefined || documentId === undefined) return;
    let live = true;
    port.openCharges(documentId).then(
      (charges) => {
        if (!live) return;
        for (const charge of charges) remember(documentId, charge);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [port, documentId, openNonce]);

  const connected = useMemo(
    () => (connections.status === 'ready' ? connections.connections : []),
    [connections],
  );
  const qrAccounts = useMemo(
    () => new Set(connected.map((connection) => `${ACCOUNT_PREFIX}${connection.accountId}`)),
    [connected],
  );
  const defaultAccount =
    connected.length === 0 ? null : `${ACCOUNT_PREFIX}${connected[0]!.accountId}`;
  const withDefault =
    untouched && defaultAccount !== null
      ? lines.map((line) =>
          line.account === NO_METHOD ? { ...line, account: defaultAccount } : line,
        )
      : lines;
  const visible = withDefault
    .filter((line) => line.qr === undefined || !done(line.qr.id))
    // A line whose QR was cancelled or expired keeps its method; a new QR is made when shown again.
    .map((line) => (line.qr !== undefined && gone(line.qr.id) ? { ...line, qr: undefined } : line));
  const pending = pendingQrPayments(documentId, recorded);
  const received = shown
    .filter((charge) => charge.status === 'paid')
    .reduce((sum, charge) => sum + charge.amount, 0);
  const onLines = new Set(visible.map((line) => line.qr?.id));
  // Shown and still payable, but not on screen now: checked on while this screen is open (the open
  // one checks itself). Payable until the server says it expired, whatever this device's clock says.
  const waiting = shown.filter((c) => c.status === 'waiting');
  const unseen = waiting.filter((c) => c.id !== open?.body.id);
  const unresolved = unseen
    .filter((c) => !onLines.has(c.id))
    .map((charge) => ({
      charge,
      cancelling: cancelling.has(charge.id),
      cancelFailed: cancelFailed.has(charge.id),
    }));
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
    const same = !fresh && line.qr?.amount === amount;
    const qr = same && line.qr !== undefined ? line.qr : { id: newId(), amount };
    const show = (): void => {
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
    // The amount changed under a QR the customer could still pay: that one is cancelled first,
    // since the bill never has two payable QRs.
    const stale = same ? undefined : line.qr;
    if (stale !== undefined && waiting.some((c) => c.id === stale.id)) {
      cancel(stale.id, show);
    } else {
      show();
    }
  };
  const lineOf = (key: string | undefined) => visible.find((line) => line.key === key);
  const toggle = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  const cancel = (id: string, then?: () => void): void => {
    if (port === undefined || documentId === undefined || cancelling.has(id)) return;
    setCancelling((set) => toggle(set, id, true));
    setCancelFailed((set) => toggle(set, id, false));
    port
      .cancel(id)
      .then(
        (charge) => {
          remember(documentId, charge);
          // Paid after all: the payment is in, and nothing more is taken for it.
          if (charge.status !== 'paid') then?.();
        },
        () => setCancelFailed((set) => toggle(set, id, true)),
      )
      .finally(() => setCancelling((set) => toggle(set, id, false)));
  };
  const patch = (key: string, change: Partial<PaymentLine>): void =>
    setLines(visible.map((line) => (line.key === key ? { ...line, ...change } : line)));

  return {
    qrAccounts,
    lines: visible,
    pending,
    received,
    unresolved,
    blocking: waiting.length,
    cancel: (id) => cancel(id),
    letGo: (id) => {
      const known = shownQrs.get(id);
      if (known === undefined || known.charge.status !== 'waiting') return;
      remember(known.documentId, {
        ...known.charge,
        status: 'cancelled',
        cancelledAt: known.charge.cancelledAt ?? Date.now(),
      });
    },
    open,
    show: (key) => {
      const line = lineOf(key);
      if (line !== undefined) openFor(line, false);
    },
    renew: () => {
      const line = lineOf(open?.key);
      if (line !== undefined) openFor(line, true);
    },
    // Closing a QR step looks again at the bill's open QRs: making one may have found another
    // device's QR open for the bill.
    close: () => {
      setOpen(null);
      setOpenNonce((n) => n + 1);
    },
    paid: (charge) => {
      if (documentId !== undefined) remember(documentId, charge);
    },
    cancelOpen: () => {
      if (open !== null) cancel(open.body.id);
      setOpen(null);
    },

    takeByHand: () => {
      if (open !== null) patch(open.key, { manual: true, qr: undefined });
      setOpen(null);
      setOpenNonce((n) => n + 1);
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
  /** Cancelled at the counter, here or on another device. */
  | { readonly kind: 'cancelled'; readonly charge: QrisCharge }
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
      } else if (charge.status === 'expired' || charge.status === 'cancelled') {
        settled = true;
        setState({ kind: charge.status, charge });
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
