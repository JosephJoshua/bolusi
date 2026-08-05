// The fetch adapter for `POST /v1/users/:userId/pin-verifier` (api/02-auth §5.4) — the
// `PinVerifierUploadPort` the pending-verifier queue (`@bolusi/core` pin-flows.ts) drains on next
// online contact, so a PIN change computed offline reaches the server and, from there, every other
// device via bundle refresh (§5.2).
//
// SAME shape as `push/transport.ts` / `enroll-transport.ts` (§2.8): a device bearer read PER CALL
// (never cached, so a revoked device stops authenticating at once — api/02-auth §7.3), a thin
// translation to the endpoint's `{ verifierRef, verifier }` body, and the failure contract the queue
// expects. The queue treats a RETURNED result as terminal (drops the item) and a THROWN error as a
// transport failure (keeps it queued for the next contact); so a 200 (`applied` true OR false — the
// §5.3 greatest-`asOf` answer) returns, and any non-2xx / network fault throws to retry later.
import type { PinVerifier, PinVerifierUploadPort, PinVerifierUploadResult } from '@bolusi/core';

export interface PinVerifierTransportConfig {
  /** Base URL of the server, no trailing slash (08 §6.1's `EXPO_PUBLIC_API_URL`). */
  readonly baseUrl: string;
  /** The `bdt_`-prefixed device token (api/02-auth §3/§8), read at call time — never cached here. */
  readonly deviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

export function createFetchPinVerifierUpload(
  config: PinVerifierTransportConfig,
): PinVerifierUploadPort {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async upload(
      userId: string,
      verifierRef: string,
      verifier: PinVerifier,
    ): Promise<PinVerifierUploadResult> {
      const token = await config.deviceToken();
      if (token === null) {
        // Fail closed: §5.4 requires the device bearer, and an anonymous POST earns a 401. Throwing
        // keeps the item queued (the token appears on next enroll/refresh) rather than dropping it.
        throw new Error('no device token available — cannot POST pin-verifier (api/02-auth §5.4)');
      }
      const response = await doFetch(`${config.baseUrl}/v1/users/${userId}/pin-verifier`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          // Self-change (task 186a): the acting user IS the target, so the server's `targetUserId ===
          // acting` check needs no permission (§6.6). An owner RESET (186b) acts on another user and
          // must carry the resetting owner here instead — the queue does not yet distinguish the two,
          // so this transport is self-change-only today (186b revisits the acting-user seam).
          'X-Acting-User': userId,
        },
        // The exact §5.4 body — strict on the server (an unknown key rejects), so send ONLY these two.
        body: JSON.stringify({ verifierRef, verifier }),
      });
      if (!response.ok) {
        // A non-2xx is a transport/server fault, not the §5.3 "stale, not applied" answer (which is a
        // 200 with `applied: false`). Throw so the queue keeps it for the next online contact.
        throw new Error(`pin-verifier upload failed: HTTP ${String(response.status)}`);
      }
      const json = (await response.json()) as { readonly applied?: unknown };
      // `userId` echoes the target we POSTed to (the server returns it); `applied` is the §5.3 answer.
      return { userId, applied: json.applied === true };
    },
  };
}
