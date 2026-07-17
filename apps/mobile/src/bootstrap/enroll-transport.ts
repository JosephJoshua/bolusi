// The enrollment control-plane transports (api/02-auth §4.2 login, §4.3 enroll) — the fetch adapters
// the enrollment caller drives. Same thin-adapter shape as sync-client's `transport.ts`/`bundle.ts`
// (§2.8): @bolusi/core owns `runEnrollment`'s LOGIC and knows nothing of `fetch`; this file is the
// wire.
//
// ── WHY A DEDICATED ERROR (not `SyncTransportError`) ────────────────────────────────────────────
// The enrollment wizard sorts every failure into one of four human actions (model.ts's
// `classifyFailure`), and one of them — 429 — needs `retryAfterSeconds` for its countdown.
// `SyncTransportError` carries only `{code, status}` because the sync loop never renders a countdown;
// it just backs off. So enrollment gets its own `EnrollHttpError` carrying the extra field, and
// `classifyFailure` reads `status`/`code`/`retryAfterSeconds` straight off it. A raw `fetch` failure
// (no HTTP response) is left to propagate as its native `TypeError`: `classifyFailure` maps a
// status-less error to `offline`, which is the one sanctioned "you need internet" in the app.
import type { EnrollRequest, EnrollResponse, EnrollTransportPort } from '@bolusi/core';

import type { LoginResult } from '../screens/enrollment/model.js';

/** A non-2xx control-plane response, carrying the api/00 §7 envelope fields the wizard buckets on. */
export class EnrollHttpError extends Error {
  override readonly name = 'EnrollHttpError';
  readonly status: number;
  readonly code: string | null;
  /** From `error.details.retryAfterSeconds` on a 429 (§9) — the wizard's countdown. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: { status: number; code: string | null; retryAfterSeconds?: number },
  ) {
    super(message);
    this.status = options.status;
    this.code = options.code;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface LoginRequestBody {
  readonly loginIdentifier: string;
  readonly password: string;
}

/** Produces the wizard's `LoginResult` (api/02-auth §4.2). */
export interface LoginTransportPort {
  login(body: LoginRequestBody): Promise<LoginResult>;
}

export interface EnrollTransportConfig {
  /** 08 §6.1's `EXPO_PUBLIC_API_URL`, no trailing slash. */
  readonly baseUrl: string;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The `200` body of `POST /v1/auth/login` (api/02-auth §4.2) — includes `tenantName` (this task). */
interface LoginResponseBody {
  readonly controlSession: string;
  readonly expiresAt: number;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly user: { readonly id: string; readonly name: string };
  readonly stores: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/**
 * Parse an api/00 §7 error envelope out of a failed control-plane response into an `EnrollHttpError`.
 * Tolerant: a captive portal or proxy can answer with HTML or an empty body, in which case `code`
 * stays null and only the HTTP status is carried — enough for `classifyFailure` to bucket it.
 */
async function toEnrollError(response: Response): Promise<EnrollHttpError> {
  let code: string | null = null;
  let message = `HTTP ${String(response.status)}`;
  let retryAfterSeconds: number | undefined;
  try {
    const body: unknown = await response.json();
    const error = (
      body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null
    )?.error;
    if (typeof error?.code === 'string') code = error.code;
    if (typeof error?.message === 'string') message = error.message;
    const details = (error?.details as { retryAfterSeconds?: unknown } | undefined)
      ?.retryAfterSeconds;
    if (typeof details === 'number') retryAfterSeconds = details;
  } catch {
    // Not JSON — leave code null; the status alone still buckets to `unexpected`/`rateLimited`.
  }
  return new EnrollHttpError(message, {
    status: response.status,
    code,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

/**
 * The `POST /v1/auth/login` transport (api/02-auth §4.2). No auth header — this is the one
 * bearer-exempt route (api/00 §1). Maps `LoginRes` onto the wizard's trimmed `LoginResult`,
 * carrying `tenantName` verbatim (the confirm step renders it; never fabricated — T-19).
 */
export function createLoginTransport(config: EnrollTransportConfig): LoginTransportPort {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async login(body: LoginRequestBody): Promise<LoginResult> {
      const response = await doFetch(`${config.baseUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginIdentifier: body.loginIdentifier, password: body.password }),
      });
      if (!response.ok) throw await toEnrollError(response);
      const res = (await response.json()) as LoginResponseBody;
      return {
        controlSession: res.controlSession,
        tenantId: res.tenantId,
        tenantName: res.tenantName,
        user: { id: res.user.id, name: res.user.name },
        stores: res.stores.map((s) => ({ id: s.id, name: s.name })),
      };
    },
  };
}

/**
 * The `POST /v1/devices/enroll` transport (api/02-auth §4.3). `controlSession` is the bearer;
 * `Idempotency-Key` is REQUIRED and passed through verbatim so a crash-retry reuses the SAME key
 * (§4.3) — the server then returns the stored response, token included, and the device is never
 * double-registered. Accepts 200/201.
 */
export function createEnrollTransport(config: EnrollTransportConfig): EnrollTransportPort {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async enroll(
      controlSession: string,
      idempotencyKey: string,
      body: EnrollRequest,
    ): Promise<EnrollResponse> {
      const response = await doFetch(`${config.baseUrl}/v1/devices/enroll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${controlSession}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await toEnrollError(response);
      return (await response.json()) as EnrollResponse;
    },
  };
}
