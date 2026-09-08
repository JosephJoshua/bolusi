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
} from '@bolusi/core';

import type { LoginResult } from '../screens/enrollment/model.js';

import type { Bootstrapped } from './bootstrap.js';
import { persistEnrolledNames } from './device-info.js';
import type { LoginTransportPort } from './enroll-transport.js';
import { createAppRuntime, type AppRuntime } from './runtime.js';

/** What `App` drives — one method per wizard step. The two async steps reject on failure; the wizard
 *  buckets it. `finish` is the synchronous step-3 handoff and never fails. */
export interface EnrollmentController {
  /** Step 1 (§4.2): exchange credentials for the control session + store list + tenant name. */
  login(req: { readonly loginIdentifier: string; readonly password: string }): Promise<LoginResult>;
  /** Step 2 (§4.3 + §4.1 steps 4–6): register the device, persist the bundle, append the genesis,
   *  and persist the identity. Does NOT hand off to the enrolled zone — that is `finish`'s job, so the
   *  wizard's success step (§8.5 step 3) renders before the switcher takes over. */
  enroll(req: {
    readonly login: LoginResult;
    readonly storeId: string;
    readonly deviceName: string;
  }): Promise<void>;
  /** Step 3 (§8.5): the owner acknowledges the success step ("Continue"). ONLY now does `onEnrolled`
   *  fire — the zone flips to the switcher and the sync loop / push registration start. Splitting this
   *  from `enroll` is what keeps the done step reachable: firing `onEnrolled` inside `enroll` recomputes
   *  the visible zone from auth truth (shell-inputs.ts) and unmounts the wizard before it can show its
   *  success step. A no-op if enrollment has not completed (nothing to hand off). */
  finish(): void;
}

/** The native-bound ports + transports, supplied by index.ts (the one op-sqlite/SecureStore site). */
export interface EnrollmentPlatform {
  readonly loginTransport: LoginTransportPort;
  readonly enrollTransport: EnrollTransportPort;
  /**
   * The SecureStore keystore. Used BOTH as the enrollment keystore (persists the seed) AND as the
   * runtime's signing key — the SAME OBJECT, so whatever seed sits in its cache is what the genesis is
   * signed with. On a FRESH enroll `runEnrollment` persists-and-caches the seed; on a RESUME after a
   * restart the keystore is rebuilt with an EMPTY cache, so `runEnrollment` reloads the persisted seed
   * from SecureStore before the genesis (enrollment.ts `loadOrCreateDraft`). The invariant this field's
   * name implies is object-identity, held across both — not "the same object always already holds it".
   */
  readonly keystore: KeyStorePort;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly idSource: IdSource;
  readonly location: LocationPort;
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
  /**
   * THE app runtime — the one composition this file builds (task 119).
   *
   * Exposed for exactly the reason `evaluator` is: something else needs it, and the alternative is a
   * SECOND `createAppRuntime` over the same connection. That second one would mint its own
   * `PermissionEvaluator` — unprimed, and never invalidated by the sync loop's bundle refresh, since
   * Root wires that hook to THIS one. The notes runtime would then answer reads from a permission memo
   * that no directory change can reach: a user whose grants were just revoked keeps reading, and a
   * user just granted access keeps being denied, with nothing failing. `evaluator` is a projection of
   * this object; both are here so the two can never be different objects (§2.8).
   */
  readonly runtime: AppRuntime;
  /**
   * Reload the persisted device seed into the keystore's in-memory cache (api/02-auth §3;
   * `KeyStorePort.loadSigningKey` — "MUST be awaited once at startup before the command runtime signs
   * its first op").
   *
   * On an already-enrolled COLD start no enrollment runs, so `runEnrollment`'s mid-flow reload — which
   * covers a resume DURING enrollment (see {@link EnrollmentPlatform.keystore}) — never fires, yet the
   * runtime must sign the session op at the FIRST PIN unlock. Root awaits this before composing the
   * session so a fresh `SecureStoreKeyStore` (empty cache, seed on disk from the original enroll) can
   * sign. Idempotent on the just-enrolled path, where the seed is already cached.
   */
  loadSigningKey(): Promise<void>;
}

/**
 * Wire the enrollment controller over a booted app.
 *
 * Builds ONE app runtime (evaluator + `runtimeFor`) and closes the controller over it, so the
 * genesis append and any later command share the same op store, evaluator and enforcement point.
 * `enroll` captures the enrolled identity once `runEnrollment` has persisted `deviceId`/`storeId` to
 * `meta_kv`; `onEnrolled` — the signal Root turns into a live sync loop — fires only when the owner
 * acknowledges the success step via `finish` (§8.5 step 3), so the wizard's done step is not
 * unmounted by the zone flip before it renders.
 */
export function createAppEnrollment(
  app: Bootstrapped,
  platform: EnrollmentPlatform,
  // `ownerUserId` travels alongside the id so the composition root can register the device's push
  // token for the just-enrolled OWNER (api/04-push §2 (b)); no PIN session exists yet, so the owner is
  // the only acting user known at this instant.
  onEnrolled: (deviceId: string, ownerUserId: string) => void,
): AppEnrollment {
  const runtime = createAppRuntime(app, {
    crypto: platform.crypto,
    clock: platform.clock,
    idSource: platform.idSource,
    location: platform.location,
    signingKey: platform.keystore,
  });

  // The identity `enroll` captured — the payload the deferred `onEnrolled` carries when `finish` runs.
  // Null until a successful `enroll`; a `finish` before then is a no-op (nothing to hand off).
  let enrolled: { readonly deviceId: string; readonly ownerUserId: string } | null = null;

  const controller: EnrollmentController = {
    login(req): Promise<LoginResult> {
      return platform.loginTransport.login(req);
    },

    async enroll(req): Promise<void> {
      const result = await runEnrollment(
        {
          db: app.db.db,
          // The SAME atomic bundle-apply mechanism the refresh path uses (bootstrap/bundle.ts): one
          // driver transaction on this connection so a mid-apply verifier-bounds throw rolls back the
          // partial directory (task 179). Wrapped in an arrow so `this` stays bound to `app.db`.
          transaction: (fn) => app.db.transaction(fn),
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
      // Persist the owner-typed device name to meta_kv (task 94), AFTER core wrote the ids AND ran
      // `applyBundle` (which now persists the store/tenant names from the enroll bundle, task 109) and
      // BEFORE the handoff — so Root's live re-derive and every later boot render the real device name
      // / store / tenant on the Settings screen rather than the blanks index.ts used to hand in. Only
      // `deviceName` is written here (it is not on the bundle); the store/tenant names are core's
      // single-writer keys, refreshed on every bundle (§2.8 — no second writer).
      await persistEnrolledNames(app, { deviceName: req.deviceName });
      // Capture, do NOT hand off. Firing `onEnrolled` here recomputes the visible zone from auth truth
      // and unmounts the wizard before its success step renders (task 201); the handoff waits for the
      // owner's Continue tap in `finish`.
      enrolled = { deviceId: result.deviceId, ownerUserId: req.login.user.id };
    },

    finish(): void {
      // Step 3 (§8.5): the owner acknowledged the success step. ONLY now signal Root to re-derive the
      // enrolled zone and start the sync loop / push registration. Guarded so a `finish` with no
      // completed `enroll` behind it does nothing.
      if (enrolled === null) return;
      onEnrolled(enrolled.deviceId, enrolled.ownerUserId);
    },
  };

  return {
    controller,
    evaluator: runtime.evaluator,
    runtime,
    // Reload the persisted seed into the SAME keystore this runtime signs through (§2.8 object
    // identity). On the just-enrolled path the seed is already cached, so this is a no-op; on an
    // already-enrolled cold start it is the ONLY thing that repopulates a fresh keystore's empty cache
    // before the session op signs. `platform.keystore` is `KeyStorePort`, which declares
    // `loadSigningKey`; the null it may return (no seed on disk) is discarded — the caller only needs
    // the cache primed, and an unenrolled cold start never reaches here (Root guards on `enroll`).
    loadSigningKey: async () => {
      await platform.keystore.loadSigningKey();
    },
  };
}
