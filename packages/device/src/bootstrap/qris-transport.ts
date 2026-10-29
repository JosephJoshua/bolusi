// The fetch adapter for QRIS through Xendit (apps/server/src/routes/qris.ts): connecting a QRIS
// method, making the QR the counter shows and asking whether it is paid, each made as the person
// signed in (`X-Acting-User`) on this device's bearer, the same shape as `staff-transport.ts`. The
// server is the authority and records the payment itself; this only translates its answers into the
// closed `QrisFailure` set the screens explain.
//
// No queue: a QR is for the customer at the counter now, so a network fault is `offline` right
// away and the counter takes the payment by hand.
import { QrisError, type QrisFailure, type QrisPort } from '@bolusi/modules/money';
import {
  zQrisCharge,
  zQrisConnection,
  zQrisConnectionsResponse,
  type QrisChargeBody,
} from '@bolusi/schemas';

export interface QrisTransportConfig {
  /** Base URL of the server, no trailing slash. */
  readonly baseUrl: string;
  /** The `bdt_` device token, read at call time, never cached. */
  readonly deviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

const BASE = '/v1/money/qris';

/**
 * A call that has not answered by then is given up as offline: on a weak signal a request can hang
 * far longer than a customer waits, and the QR step polls again or offers taking it by hand.
 */
export const QRIS_CALL_TIMEOUT_MS = 15_000;

/** A schema's `safeParse`, structurally: this package does not depend on zod itself. */
interface Parser<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/** The port for one signed-in person; a switch of user binds a new one. */
export function createFetchQris(config: QrisTransportConfig): (actingUserId: string) => QrisPort {
  const doFetch = config.fetchImpl ?? fetch;

  return (actingUserId) => {
    const call = async (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<unknown> => {
      const token = await config.deviceToken();
      if (token === null) throw new QrisError('unexpected');
      let response: Response;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), QRIS_CALL_TIMEOUT_MS);
      try {
        response = await doFetch(`${config.baseUrl}${BASE}${path}`, {
          method,
          signal: abort.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Acting-User': actingUserId,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // fetch rejects only when no answer came back: no connection, DNS, a dropped socket, or
        // no answer in time.
        throw new QrisError('offline');
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new QrisError(await failureOf(response));
      return response.status === 204 ? null : response.json().catch(() => undefined);
    };
    const parsed = <T>(schema: Parser<T>, json: unknown): T => {
      const result = schema.safeParse(json);
      if (!result.success) throw new QrisError('unexpected');
      return result.data;
    };

    return {
      connections: async () =>
        parsed(zQrisConnectionsResponse, await call('GET', '/accounts')).connections,
      connect: async (accountId, secretKey) =>
        parsed(
          zQrisConnection,
          await call('PUT', `/accounts/${encodeURIComponent(accountId)}`, { secretKey }),
        ),
      disconnect: async (accountId) => {
        await call('DELETE', `/accounts/${encodeURIComponent(accountId)}`);
      },
      createCharge: async (body: QrisChargeBody) =>
        parsed(zQrisCharge, await call('POST', '/charges', body)),
      charge: async (id) =>
        parsed(zQrisCharge, await call('GET', `/charges/${encodeURIComponent(id)}`)),
      simulate: async (id) =>
        parsed(zQrisCharge, await call('POST', `/charges/${encodeURIComponent(id)}/simulate`)),
    };
  };
}

const BY_CODE: Readonly<Record<string, QrisFailure>> = {
  QRIS_NOT_CONNECTED: 'notConnected',
  QRIS_KEY_REFUSED: 'keyRefused',
  QRIS_AMOUNT_REFUSED: 'amountRefused',
  QRIS_UNAVAILABLE: 'unavailable',
  CHANGE_REFUSED: 'refused',
};

/** The api/00 §7 error envelope's code, mapped to what the counter can do about it. */
async function failureOf(response: Response): Promise<QrisFailure> {
  const json = (await response.json().catch(() => null)) as {
    readonly error?: { readonly code?: unknown };
  } | null;
  const code = json?.error?.code;
  if (typeof code === 'string' && BY_CODE[code] !== undefined) return BY_CODE[code];
  if (response.status === 403) return 'denied';
  if (response.status === 404) return 'notFound';
  // A gateway with no route to the server is the same as no connection.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return 'offline';
  }
  return 'unexpected';
}
