// The window's line to the offline core. It asks main (through the preload) for a port, and speaks
// the shared rpc over it. Errors come back as the core's own classes, so `DomainError` and
// `RuleRefusal` checks in the screens work as they do on the phone, where everything is one process.
import {
  DomainError,
  isDomainErrorCode,
  RuleRefusal,
  StaffAdminError,
  type DomainErrorDetails,
  type StaffAdminFailure,
} from '@bolusi/core';
import { QRIS_FAILURES, QrisError, type QrisFailure } from '@bolusi/modules/money';

import { CORE_EVENTS, type CoreState, type RepairChange } from '../core/api.js';
import { markFresh } from '@bolusi/ui-web';
import { CORE_PORT_MESSAGE, type CorePortMode, type DesktopBridge } from '../main/bridge.js';
import { connect, RemoteError, type Channel, type Client, type WireError } from '../main/rpc.js';

export type CoreConnection =
  | { readonly mode: 'live'; readonly client: Client }
  | { readonly mode: 'demo' }
  | { readonly mode: 'unavailable' };

const STAFF_FAILURES: readonly StaffAdminFailure[] = [
  'offline',
  'denied',
  'lastOwner',
  'rateLimited',
  'unexpected',
];

/** Rebuild the error the core threw, as its own class when it is a domain, staff or QRIS error. */
export function reviveCoreError(wire: WireError): Error {
  const { code, details, refusal, reason } = wire.fields;
  // A refused staff change says why, so "Karyawan" can tell offline from a refusal.
  if (wire.name === 'StaffAdminError') {
    return new StaffAdminError(
      STAFF_FAILURES.includes(reason as StaffAdminFailure)
        ? (reason as StaffAdminFailure)
        : 'unexpected',
    );
  }
  // So the QR and Xendit's settings can say offline, refused or Xendit down.
  if (wire.name === 'QrisError') {
    return new QrisError(
      QRIS_FAILURES.includes(reason as QrisFailure) ? (reason as QrisFailure) : 'unexpected',
    );
  }
  if (wire.name !== 'DomainError' || typeof code !== 'string' || !isDomainErrorCode(code)) {
    return new RemoteError(wire);
  }
  const plain =
    typeof details === 'object' && details !== null ? (details as DomainErrorDetails) : undefined;
  // A refusal's details already carry the reason; the class puts it back the same way.
  if (typeof refusal === 'string') return new RuleRefusal(code, refusal, plain, wire.message);
  return new DomainError(code, plain, wire.message);
}

function portChannel(port: MessagePort): Channel {
  return {
    send: (message) => port.postMessage(message),
    listen(onMessage) {
      const handler = (event: MessageEvent): void => onMessage(event.data);
      port.addEventListener('message', handler);
      port.start();
      return () => port.removeEventListener('message', handler);
    },
  };
}

function bridge(): DesktopBridge['core'] | undefined {
  return (window as { bolusi?: Partial<DesktopBridge> }).bolusi?.core;
}

/** Whether this window runs inside the desktop app; without it the window shows the seeded demo. */
export function hasCoreBridge(): boolean {
  return bridge() !== undefined;
}

let connection: Promise<CoreConnection> | null = null;
let latest: CoreState | null = null;

/** The last state the core sent, for a view that starts listening after it arrived. */
export function latestCoreState(): CoreState | null {
  return latest;
}

/**
 * Connect to the core, once per page load (a reload gets a fresh port from main). Outside the
 * desktop app (the dev server in a browser) there is no bridge, and the window runs the seeded demo.
 */
export function connectToCore(): Promise<CoreConnection> {
  connection ??= requestPort();
  return connection;
}

function requestPort(): Promise<CoreConnection> {
  const core = bridge();
  if (core === undefined) return Promise.resolve({ mode: 'demo' });
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      // Only the preload, posting to this very window, hands over the port; a message from the
      // print frame or anywhere else is ignored.
      if (event.source !== window) return;
      const data = event.data as { type?: unknown; mode?: CorePortMode } | null;
      if (data?.type !== CORE_PORT_MESSAGE) return;
      window.removeEventListener('message', onMessage);
      const [port] = event.ports;
      if (data.mode === 'live' && port !== undefined) {
        const client = connect(portChannel(port), reviveCoreError);
        client.on(CORE_EVENTS.state, (state) => {
          latest = state as CoreState;
        });
        // What a colleague just changed on another device glows once wherever it shows.
        client.on(CORE_EVENTS.repairChanged, (change) => {
          const fresh = (change as RepairChange | null)?.freshId;
          if (typeof fresh === 'string') markFresh(fresh);
        });
        resolve({ mode: 'live', client });
      } else {
        resolve({ mode: data.mode === 'demo' ? 'demo' : 'unavailable' });
      }
    };
    window.addEventListener('message', onMessage);
    core.connect();
  });
}
