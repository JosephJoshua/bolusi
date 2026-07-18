// Wire schema for `POST /v1/push/tokens` (api/04-push §2). Kept LOCAL to @bolusi/server rather than
// in the CONTENDED @bolusi/schemas package — the same precedent media set (apps/server/src/media/
// schemas.ts): task 02 shipped no push DTOs, and touching the shared package needs serialization
// (CLAUDE.md §4). Shared PRIMITIVES (`zUuid`) are imported, never re-defined (§2.8); only the
// endpoint's own request shape lives here. Lifting this into @bolusi/schemas for client + RPC reuse
// is a follow-up, exactly as the media header notes for its DTOs.
import { z } from 'zod';

import { zUuid } from '@bolusi/schemas';

/**
 * The Expo push token shape (api/04-push §2): `ExponentPushToken[…]`. A token that does not match
 * (an FCM raw token, an empty bracket, junk) fails here → `422 VALIDATION_FAILED` (acceptance).
 * `getExpoPushTokenAsync` yields exactly this form (verified via Context7).
 */
export const EXPO_PUSH_TOKEN_RE = /^ExponentPushToken\[[^\]]+\]$/;

/** `POST /v1/push/tokens` body (api/04-push §2). Strict: an unknown key rejects — the upsert
 *  comparison must be total, and there is no `Idempotency-Key` semantics here (§2). */
export const zPushTokenRegisterBody = z.strictObject({
  expoPushToken: z.string().regex(EXPO_PUSH_TOKEN_RE),
  deviceId: zUuid,
});
export type PushTokenRegisterBody = z.infer<typeof zPushTokenRegisterBody>;

/** `200` response (api/04-push §2): the device id and the server-stamped `updated_at` (ms epoch). */
export interface PushTokenRegisterResponse {
  readonly deviceId: string;
  readonly updatedAt: number;
}

/**
 * Registration rate limit (api/04-push §2: "30 token registrations per day per device"). A daily
 * budget is a FIXED WINDOW, not a per-minute token bucket — expressed against the same
 * `WindowLimitStore` the identity §9 limits use (identity/rate-limits.ts), reusing that mechanism
 * rather than the transport token-bucket, which by construction cannot express a daily window (its
 * burst capacity and refill rate are one parameter). Numbers owned by api/04-push, per the api/00
 * §11 delegation.
 */
export const PUSH_REGISTER_PER_DAY = { limit: 30, windowMs: 24 * 60 * 60 * 1000 } as const;
