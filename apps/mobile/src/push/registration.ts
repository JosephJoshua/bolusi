// Client push-token registration (api/04-push §2). Acquires the Expo push token via
// `getExpoPushTokenAsync({ projectId })` and POSTs it to `POST /v1/push/tokens` on two triggers:
//   (a) EVERY APP START — but only when the token DIFFERS from the last-registered value (token
//       rotation, security-guide §9.1); an identical token issues ZERO requests.
//   (b) IMMEDIATELY AFTER ENROLLMENT — always, so the server stamps `user_id` for the just-enrolled
//       device (api/04-push §2/§4).
// After a `DeviceNotRegistered` invalidation (server §8) the next app start re-registers naturally
// via (a): the persisted last-registered value is unrelated to the server row, so a fresh token or a
// server-side delete both lead back through (a).
//
// The bearer + `deviceId` + optional `X-Acting-User` are the CALLER's to supply (they live in the
// authenticated transport, wired at the composition root) — `postToken` is the injected seam, which
// is also what keeps this unit-testable with `expo-notifications` mocked and NO real network.
import * as Notifications from 'expo-notifications';

export type RegistrationOutcome = 'sent' | 'unchanged' | 'skipped';

export interface PushRegistrationPorts {
  /** EAS project id for `getExpoPushTokenAsync` (api/04-push §7). */
  readonly projectId: string;
  /** The last token this device successfully registered (plain local storage). Null if never. */
  readLastRegistered(): Promise<string | null>;
  /** Persist the token just registered (so app-start (a) can diff against it). */
  writeLastRegistered(token: string): Promise<void>;
  /** POST the token to the server over the authenticated transport (bearer + deviceId + acting user). */
  postToken(expoPushToken: string): Promise<void>;
  /** Diagnostics sink for a token-acquisition or POST failure — NEVER thrown (offline is normal). */
  onError?(error: unknown): void;
}

/** Acquire the Expo push token string (api/04-push §7). May reject when offline — callers handle it. */
export async function acquireExpoPushToken(projectId: string): Promise<string> {
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}

/**
 * App-start trigger (api/04-push §2 (a)). Registers ONLY when the freshly-acquired token differs
 * from the last-registered value — an unchanged token issues no request. A failure (offline, no
 * token) is swallowed to `skipped`: push is best-effort and must never block startup (api/04-push §1).
 */
export async function registerPushTokenOnAppStart(
  ports: PushRegistrationPorts,
): Promise<RegistrationOutcome> {
  try {
    const token = await acquireExpoPushToken(ports.projectId);
    const last = await ports.readLastRegistered();
    if (token === last) return 'unchanged';
    await ports.postToken(token);
    await ports.writeLastRegistered(token);
    return 'sent';
  } catch (error) {
    ports.onError?.(error);
    return 'skipped';
  }
}

/**
 * Enrollment-completion trigger (api/04-push §2 (b)). ALWAYS registers — the newly-enrolled device
 * needs its `user_id` stamped even if the device token itself has not changed since a pre-login
 * registration. Same best-effort failure handling as app start.
 */
export async function registerPushTokenOnEnrollment(
  ports: PushRegistrationPorts,
): Promise<RegistrationOutcome> {
  try {
    const token = await acquireExpoPushToken(ports.projectId);
    await ports.postToken(token);
    await ports.writeLastRegistered(token);
    return 'sent';
  } catch (error) {
    ports.onError?.(error);
    return 'skipped';
  }
}
