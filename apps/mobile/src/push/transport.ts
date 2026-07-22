// The fetch adapter for `POST /v1/push/tokens` (api/04-push §2) — the `postToken` port
// `registration.ts` leaves to "the CALLER's to supply … wired at the composition root".
//
// Deliberately the SAME shape as `src/bootstrap/transport.ts` (the sync wire) rather than a second
// invention (§2.8): a device bearer read PER CALL (never cached, so a revoked device stops
// authenticating at once, api/02-auth §7.3), and a thin translation to the endpoint's body.
//
// Best-effort by contract (api/04-push §1): every failure here THROWS, and `registration.ts`'s
// try/catch swallows it to `skipped` — so a missing token, an offline device, or a 4xx/5xx never
// blocks or crashes the boot. The bearer is fail-closed (a null token throws rather than sending an
// anonymous POST that would earn a 401 anyway).
export interface PushTokenTransportConfig {
  /** Base URL of the server, no trailing slash (08 §6.1's `EXPO_PUBLIC_API_URL`). */
  readonly baseUrl: string;
  /** THIS device's id — the body binds the token to it; the server 403s a mismatch (api/04-push §2). */
  readonly deviceId: string;
  /** The `bdt_`-prefixed device token (api/02-auth §3/§8), read at call time — never cached here. */
  readonly deviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A `postToken(expoPushToken, actingUserId)` closed over the device's transport. `actingUserId` rides
 * the OPTIONAL `X-Acting-User` header (api/00 §3): present when a session is active (server stamps
 * `user_id`), omitted when `null` (server stamps `user_id = null`, api/04-push §2).
 */
export function createFetchPushTransport(
  config: PushTokenTransportConfig,
): (expoPushToken: string, actingUserId: string | null) => Promise<void> {
  const doFetch = config.fetchImpl ?? fetch;

  return async (expoPushToken: string, actingUserId: string | null): Promise<void> => {
    const token = await config.deviceToken();
    if (token === null) {
      // Fail closed: api/04-push §2 requires the device bearer, and an anonymous POST earns a 401.
      // Registration swallows this to `skipped` (best-effort, §1) — the next app start retries.
      throw new Error('no device token available — cannot register push token (api/04-push §2)');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    // Only when a session is active — an empty/absent header makes the server stamp `user_id = null`.
    if (actingUserId !== null) headers['X-Acting-User'] = actingUserId;

    const response = await doFetch(`${config.baseUrl}/v1/push/tokens`, {
      method: 'POST',
      headers,
      // The exact §2 body: strict on the server (an unknown key rejects), so send ONLY these two.
      body: JSON.stringify({ expoPushToken, deviceId: config.deviceId }),
    });
    if (!response.ok) {
      throw new Error(`push token registration failed: HTTP ${String(response.status)}`);
    }
  };
}
