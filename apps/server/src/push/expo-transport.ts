// The PRODUCTION Expo transport + the fail-closed push-port builder (api/04-push §7; 08 §8).
//
// `ExpoPushSender` (expo-sender.ts) is deliberately transport-agnostic: it takes an INJECTED
// `PushTransport` and never a hard `fetch` (08 §3.3 — no `expo-*` server-side; the boundary lint
// flags a raw dependency). This module is the ONE place that binds the real HTTP call, so the
// sender stays unit-testable against a recording transport and the network lives at exactly one
// seam. `pushPortFromConfig` is the composition step main.ts calls to turn the Zod-validated
// `EXPO_ACCESS_TOKEN` into the production `PushPort`.
//
// FAIL CLOSED (task 134). Push has no honest no-op: a server that accepts `POST /v1/push/tokens`
// (tasks 21/118) but never delivers is the exact defect this task removes. So an ABSENT token is
// not a graceful "push off" — it throws here, at boot, from main.ts, before the server serves.
// `SYSTEM_KEY_DIR` may be unset (detection off is a real v0 state); `EXPO_ACCESS_TOKEN` may not.
import { ExpoPushSender, type PushTransport } from './expo-sender.js';
import type { PushPort } from './port.js';
import type { ServerConfig } from '../config.js';

/** Per-attempt request timeout (ms). Delivery is off the request path (dispatcher.ts), but a stalled
 *  socket must not pin a background task forever — `AbortSignal.timeout` bounds every attempt, and an
 *  abort surfaces as a throw the sender retries then drops (api/04-push §6, §8). */
const EXPO_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The production `PushTransport`: POST JSON to the Expo push HTTP API with the access token as a
 * bearer credential (api/04-push §7; the send/getReceipts URLs are the sender's, passed as `url`).
 * `fetch` is Node 22's global. A network throw — including an `AbortSignal.timeout` firing on a
 * stalled socket — propagates as a retryable failure (expo-sender.ts `#tryPost` treats a throw /
 * non-2xx as retry); a `401` from a missing-security token lands as `ok: false` → retried then
 * dropped-and-logged, never silently succeeding, and never hanging.
 */
export function expoFetchTransport(
  accessToken: string,
  timeoutMs: number = EXPO_REQUEST_TIMEOUT_MS,
): PushTransport {
  return async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json() as Promise<unknown>,
    };
  };
}

/**
 * Build the production push port from boot config. Throws — LOUD, at boot — when the token is
 * absent, because a silent push port is the task-134 defect (there is no graceful no-op for push).
 * The error names the missing var and the fix, never a token value.
 */
export function pushPortFromConfig(config: ServerConfig): PushPort {
  if (config.expoAccessToken === undefined) {
    throw new Error(
      'EXPO_ACCESS_TOKEN is not set — refusing to boot with a dead push port (api/04-push §7, ' +
        '08 §8). Push has no honest no-op: a server that accepts POST /v1/push/tokens but never ' +
        'delivers is the task-134 defect. Set EXPO_ACCESS_TOKEN in the environment (.env).',
    );
  }
  return new ExpoPushSender({
    transport: expoFetchTransport(config.expoAccessToken),
    // `InvalidCredentials` is a config problem, not data (api/04-push §8): surface it loudly rather
    // than dropping it into the best-effort log with the transient errors.
    onInvalidCredentials: (event) =>
      console.error(
        `[push] InvalidCredentials for device ${event.deviceId} — check EXPO_ACCESS_TOKEN`,
      ),
    // Per-message / batch failures are logged, never surfaced as sync errors (api/04-push §6).
    logger: (event) => console.warn('[push] expo sender', event),
  });
}
