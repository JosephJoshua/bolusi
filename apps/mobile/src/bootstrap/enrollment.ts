// The enrollment CALLER (api/02-auth §4.1) — the path a real device takes to become enrolled, and
// the thing `App`'s `onLogin`/`onEnroll` were `noop` for. It wires the login + enroll transports to
// core's `runEnrollment`, whose genesis append runs through the composed command runtime (runtime.ts)
// and the production op store (@bolusi/db-client). On success it signals `onEnrolled` so the
// composition root re-derives the enrolled `deviceId` and starts the sync loop WITHOUT a reboot
// (task 88 persisted the id; task 89's loop gates on it).
//
// ── THE STEP ORDER IS core's, NOT this file's ──────────────────────────────────────────────────
// This file does NOT re-implement the §4.1 flow (draft → POST → token → bundle → genesis →
// deviceId persist → draft delete). That is `runEnrollment`'s contract, tested in core. This is the
// composition that gives it its two platform-supplied dependencies: the enroll transport and the
// `runtimeFor` factory. Everything else (idempotency-key reuse on crash-retry, the genesis
// idempotency guard, the meta_kv writes) is core's, exercised end-to-end here against a real client
// DB in `enrollment.test.ts`.
//
// ── NODE-SAFE ───────────────────────────────────────────────────────────────────────────────────
// core + a type only. The native ports (SecureStore keystore, quick-crypto, expo-location, the fetch
// transports) arrive as injected values from index.ts, so this whole caller runs headless under a
// fake transport + a real better-sqlite3 client DB (the honest ceiling below a running server/device).
import {
  runEnrollment,
  type ClockPort,
  type CommandRuntime,
  type CryptoPort,
  type DeviceIdentity,
  type EnrollTransportPort,
  type IdSource,
  type KeyStorePort,
  type LocationPort,
  type PermissionEvaluator,
  type SyncSchedulerPort,
} from '@bolusi/core';

import type { LoginResult } from '../screens/enrollment/model.js';

import type { Bootstrapped } from './bootstrap.js';
import type { LoginTransportPort } from './enroll-transport.js';
import { createAppRuntime } from './runtime.js';

/** What `App` drives — one method per wizard step. Both reject on failure; the wizard buckets it. */
export interface EnrollmentController {
  /** Step 1 (§4.2): exchange credentials for the control session + store list + tenant name. */
  login(req: { readonly loginIdentifier: string; readonly password: string }): Promise<LoginResult>;
  /** Step 2 (§4.3 + §4.1 steps 4–6): register the device, persist the bundle, append the genesis,
   *  persist the identity, and signal the loop to start. */
  enroll(req: {
    readonly login: LoginResult;
    readonly storeId: string;
    readonly deviceName: string;
  }): Promise<void>;
}

/** The native-bound ports + transports, supplied by index.ts (the one op-sqlite/SecureStore site). */
export interface EnrollmentPlatform {
  readonly loginTransport: LoginTransportPort;
  readonly enrollTransport: EnrollTransportPort;
  /** The SecureStore keystore. Used BOTH as the enrollment keystore (persists the seed) AND as the
   *  runtime's signing key — the SAME object, so the seed `runEnrollment` caches is what the genesis
   *  is signed with. */
  readonly keystore: KeyStorePort;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly idSource: IdSource;
  readonly location: LocationPort;
  /** No loop runs during enrollment, so a no-op is honest here — the loop's boot sync pushes the
   *  genesis once Root starts it on success. Task 25's command runtime binds the real trigger. */
  readonly syncScheduler: SyncSchedulerPort;
  readonly platform: 'android' | 'ios';
  readonly appVersion: string;
}

/** The wired enrollment surface: the controller `App` drives + the evaluator the loop invalidates. */
export interface AppEnrollment {
  readonly controller: EnrollmentController;
  /**
   * The permission evaluator, shared with the (future) command runtime. The composition root wires
   * its `onBundleRefresh` invalidation into the sync client's bundle refresh (02-permissions §6 (a)),
   * and primes it once the directory exists. Exposed so ONE evaluator serves both — not a second
   * object that would silently disagree (§2.8).
   */
  readonly evaluator: PermissionEvaluator;
}

/**
 * Wire the enrollment controller over a booted app.
 *
 * Builds ONE app runtime (evaluator + `runtimeFor`) and closes the controller over it, so the
 * genesis append and any later command share the same op store, evaluator and enforcement point.
 * `onEnrolled` fires AFTER `runEnrollment` has persisted `deviceId`/`storeId` to `meta_kv` — the
 * signal Root turns into a live sync loop.
 */
export function createAppEnrollment(
  app: Bootstrapped,
  platform: EnrollmentPlatform,
  onEnrolled: (deviceId: string) => void,
): AppEnrollment {
  const runtime = createAppRuntime(app, {
    crypto: platform.crypto,
    clock: platform.clock,
    idSource: platform.idSource,
    location: platform.location,
    signingKey: platform.keystore,
    syncScheduler: platform.syncScheduler,
  });

  const controller: EnrollmentController = {
    login(req): Promise<LoginResult> {
      return platform.loginTransport.login(req);
    },

    async enroll(req): Promise<void> {
      const result = await runEnrollment(
        {
          db: app.db.db,
          crypto: platform.crypto,
          idSource: platform.idSource,
          keystore: platform.keystore,
          transport: platform.enrollTransport,
          // The factory `runEnrollment` calls once, mid-flow, with the enroll response's identity
          // (tenant/store/device now known) to emit the genesis op through the sanctioned channel.
          runtimeFor: (identity: DeviceIdentity): CommandRuntime => runtime.runtimeFor(identity),
        },
        {
          ownerUserId: req.login.user.id,
          controlSession: req.login.controlSession,
          storeId: req.storeId,
          deviceName: req.deviceName,
          platform: platform.platform,
          appVersion: platform.appVersion,
        },
      );
      onEnrolled(result.deviceId);
    },
  };

  return { controller, evaluator: runtime.evaluator };
}
