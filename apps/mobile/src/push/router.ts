// Notification-tap routing (api/04-push §4/§6) — the production side of the deep-link that
// `resolvePushRoute` (routes.ts) was written for and nothing called.
//
// TWO PIECES, both Node-safe (no `expo-notifications` import — the native listener is a PORT, bound at
// index.ts):
//   1. `PushRouterPort` — the seam over `addNotificationResponseReceivedListener` (warm taps) and
//      `getLastNotificationResponseAsync` (the tap that COLD-STARTED the app from a killed state,
//      api/04-push §6). Injected so `Root` can be driven from a fake in the composed test, exactly as
//      `createSync`/`appState` are.
//   2. `resolvePushShellRoute` — the pure resolver: an untrusted payload → a REACHABLE shell route, or
//      `null` (navigate nowhere). It composes `resolvePushRoute` (which validates the wire shape and
//      the entity id) with the v0 shell's route map.
//
// WHY BOTH v0 CATEGORIES LAND ON `syncStatus`. `resolvePushRoute` returns `conflicts`/`devices`
// screens (the wire's route registry, api/04-push §4), but the v0 shell's `ShellRoute` union
// (navigation/zone.ts) has no conflict- or device-DETAIL screen — its reachable surfaces are `home`,
// `syncStatus`, `settings`. The Sync Status screen is the one that surfaces both classes: its
// `SyncProblem` list carries `rejected`/`quarantined` (the conflict class) AND `deviceRevoked`/
// `pushHalted` (the device class). So a `conflict` or `device` tap opens the surface that shows what is
// wrong; the screen then loads its own data from local projections (api/04-push §4 — the push carried
// none). The entity ids `resolvePushRoute` extracted are DROPPED here on purpose: nothing in v0
// consumes a `conflictId`/`deviceId` yet, and the dedicated detail screens are a future module surface
// (the `ShellRoute` comment: "Module screens extend this union"). Pointing at a route that does not
// exist is the failure this indirection prevents — every target below is a member of `ShellRoute`.
import type { ShellRoute } from '../navigation/zone.js';

import { resolvePushRoute } from './routes.js';

/** A tapped notification's payload — `response.notification.request.content.data` (api/04-push §4). */
export interface PushResponse {
  readonly data: unknown;
}

/**
 * The native notification-response seam (api/04-push §6). Bound over `expo-notifications` at index.ts
 * (the one site that may import native modules); a test injects a fake.
 */
export interface PushRouterPort {
  /** Warm taps: a user tapped a notification while the app was running. Returns an unsubscribe. */
  subscribeToResponses(handler: (response: PushResponse) => void): () => void;
  /**
   * The tap that launched the app from a KILLED state (api/04-push §6 killed-app delivery), or `null`.
   * Resolved once at boot — the warm listener never fires for it, so without this a cold-start deep
   * link is lost.
   */
  getInitialResponse(): Promise<PushResponse | null>;
}

/** What the composition root hands the shell to drive one navigation. A fresh object PER TAP, so a
 *  repeat tap to the same route re-navigates (object identity is the shell effect's trigger). */
export interface PushRouteRequest {
  readonly route: ShellRoute;
}

/**
 * Resolve an untrusted push payload to a REACHABLE shell route, or `null` when it does not map to one
 * (an unknown route key, a missing id, or a `sync` data-only wake — all handled by `resolvePushRoute`).
 * Total and defensive: a killed-app payload is untrusted input (routes.ts header).
 *
 * `null` MUST navigate nowhere — that is the positive control that keeps "always navigates" from
 * passing. Both known categories map to `syncStatus` (see the file header for why).
 */
export function resolvePushShellRoute(data: unknown): ShellRoute | null {
  const nav = resolvePushRoute(data);
  if (nav === null) return null;
  // `conflicts` and `devices` both surface on the Sync Status screen (SyncProblem: rejected/
  // quarantined/deviceRevoked/pushHalted) — the one reachable "something needs attention" surface.
  return 'syncStatus';
}
