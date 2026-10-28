// The Xendit QR Codes API (api-version 2022-07-31), the few calls Bolusi makes: point the account's
// QR webhook at this server, make a dynamic QR for one amount, list a QR's payments, and in test
// mode pay a QR. Each call takes the account's own secret key: every store or the franchise has
// its own Xendit account (no xenPlatform), and a key is only ever opened for the call that needs it.
//
// The port speaks Bolusi's words, so the service never reads Xendit's JSON and tests swap in a fake.
// A refusal Xendit gives a reason for is a `XenditRefusal`; anything else (no answer, a 5xx, a body
// we cannot read) is `XenditUnavailable`, which callers treat as "try again later".
import type { QrisEnvironment } from '@bolusi/schemas';

export const XENDIT_API = 'https://api.xendit.co';
const API_VERSION = '2022-07-31';

export type XenditRefusalReason = 'keyInvalid' | 'keyNotAllowed' | 'amountNotAllowed' | 'notFound';

export class XenditRefusal extends Error {
  constructor(readonly reason: XenditRefusalReason) {
    super(`Xendit refused: ${reason}`);
    this.name = 'XenditRefusal';
  }
}

export class XenditUnavailable extends Error {
  constructor(detail: string) {
    super(`Xendit unavailable: ${detail}`);
    this.name = 'XenditUnavailable';
  }
}

export interface XenditQr {
  readonly qrId: string;
  readonly qrString: string;
}

export interface XenditQrPayment {
  readonly paymentId: string;
  readonly amount: number;
  readonly succeeded: boolean;
  /** When the customer paid, by Xendit's clock; null when Xendit's answer did not say. */
  readonly paidAt: number | null;
}

export interface XenditPort {
  /** Points the account's QR payment webhook at `url`; returns the token Xendit will send with it. */
  setQrWebhook(
    secretKey: string,
    url: string,
  ): Promise<{ readonly callbackToken: string; readonly environment: QrisEnvironment }>;
  createDynamicQr(
    secretKey: string,
    input: { readonly referenceId: string; readonly amount: number; readonly expiresAt: number },
  ): Promise<XenditQr>;
  listQrPayments(secretKey: string, qrId: string): Promise<readonly XenditQrPayment[]>;
  /** Test mode only: Xendit pays the QR as a customer would. */
  simulateQrPayment(secretKey: string, qrId: string, amount: number): Promise<void>;
}

/** Test keys start `xnd_development_`; live keys `xnd_production_`. */
export function environmentOfKey(secretKey: string): QrisEnvironment {
  return secretKey.startsWith('xnd_development_') ? 'test' : 'live';
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

export function createXenditClient(
  options: { readonly baseUrl?: string; readonly fetchImpl?: typeof fetch } = {},
): XenditPort {
  const baseUrl = options.baseUrl ?? XENDIT_API;
  const doFetch = options.fetchImpl ?? fetch;

  const call = async (
    secretKey: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
          'api-version': API_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new XenditUnavailable(error instanceof Error ? error.name : 'fetch failed');
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && json !== null) return json;
    const code = typeof json?.['error_code'] === 'string' ? json['error_code'] : '';
    if (response.status === 401 || code === 'INVALID_API_KEY')
      throw new XenditRefusal('keyInvalid');
    if (response.status === 403) throw new XenditRefusal('keyNotAllowed');
    if (response.status === 404) throw new XenditRefusal('notFound');
    if (response.status === 400 && code === 'API_VALIDATION_ERROR' && path === '/qr_codes') {
      throw new XenditRefusal('amountNotAllowed');
    }
    throw new XenditUnavailable(`${String(response.status)} ${code}`);
  };

  return {
    async setQrWebhook(secretKey, url) {
      const json = await call(secretKey, 'POST', '/callback_urls/qr_code', { url });
      const token = json['callback_token'];
      if (typeof token !== 'string' || token === '') {
        throw new XenditUnavailable('no callback token');
      }
      return {
        callbackToken: token,
        environment: json['environment'] === 'LIVE' ? 'live' : environmentOfKey(secretKey),
      };
    },

    async createDynamicQr(secretKey, input) {
      const json = await call(secretKey, 'POST', '/qr_codes', {
        reference_id: input.referenceId,
        type: 'DYNAMIC',
        currency: 'IDR',
        amount: input.amount,
        expires_at: new Date(input.expiresAt).toISOString(),
      });
      const qrId = json['id'];
      const qrString = json['qr_string'];
      if (typeof qrId !== 'string' || typeof qrString !== 'string') {
        throw new XenditUnavailable('unreadable QR');
      }
      return { qrId, qrString };
    },

    async listQrPayments(secretKey, qrId) {
      const json = await call(secretKey, 'GET', `/qr_codes/${encodeURIComponent(qrId)}/payments`);
      const data = Array.isArray(json['data']) ? (json['data'] as Record<string, unknown>[]) : [];
      return data.flatMap((payment) =>
        typeof payment['id'] === 'string' && typeof payment['amount'] === 'number'
          ? [
              {
                paymentId: payment['id'],
                amount: payment['amount'],
                succeeded: payment['status'] === 'SUCCEEDED',
                paidAt: timeOf(payment['created']),
              },
            ]
          : [],
      );
    },

    async simulateQrPayment(secretKey, qrId, amount) {
      await call(secretKey, 'POST', `/qr_codes/${encodeURIComponent(qrId)}/payments/simulate`, {
        amount,
      });
    },
  };
}
