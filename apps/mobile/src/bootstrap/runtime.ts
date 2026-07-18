// The mobile command-runtime composition (04-module-contract §5/§6) — the layer that turns the
// booted data layer into a runnable `CommandRuntime`, and the producer `runEnrollment`'s genesis
// append (api/02-auth §4.1 step 6) was waiting for.
//
// ── WHAT WAS MISSING (T-16: a mention is not a producer) ────────────────────────────────────────
// `runEnrollment` appends the genesis op through `deps.runtimeFor(device)` → a full `CommandRuntime`
// → an `OpAppendStore`. Nothing in shipping source composed one: no `createModuleRuntime` call, no
// `OpAppendStore` over db-client. So a production device could log in and POST enroll but never write
// seq 1 — `deviceId` never persisted, the sync loop never started. This file is the composition, and
// `createClientOpStore` (@bolusi/db-client, this task) is the store it plugs in.
//
// ── ONE COMPOSITION, NOT A SECOND (§2.8) ────────────────────────────────────────────────────────
// The runtime is wired through core's `createModuleRuntime`, THE factory (module/runtime.ts), which
// ties the command/query knot in one place and shares ONE enforcement point. This file adds no
// runtime logic; it only binds the platform ports. The evaluator is built from the SAME permission
// registry the runtime enforces against (`app.registry.permissions`), so "the evaluator and the
// runtime agree" is true by construction, not by convention.
//
// ── NODE-SAFE BY CONSTRUCTION ───────────────────────────────────────────────────────────────────
// Every import here is core / db-client / a type — no expo, no op-sqlite. The effectful ports
// (crypto, keystore, clock, idSource, location) arrive as injected values, so this whole module runs
// under Node against noble + a fake keystore + a seeded IdSource (T-6). The native bindings are
// supplied by index.ts, the one op-sqlite/SecureStore site.
import {
  createModuleRuntime,
  createDirectorySource,
  PermissionEvaluator,
  type ClockPort,
  type CommandRuntime,
  type CryptoPort,
  type DeviceIdentity,
  type IdSource,
  type LocationPort,
  type SigningKeyPort,
  type SyncSchedulerPort,
} from '@bolusi/core';
import { createClientOpStore } from '@bolusi/db-client';

import type { Bootstrapped } from './bootstrap.js';
import { systemTimer } from '../ports/timer.js';

/** The platform ports the command runtime needs, injected (08 §3.2). */
export interface AppRuntimeDeps {
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  /** UUIDv7 source over the clock + a CSPRNG (05 §2.1). */
  readonly idSource: IdSource;
  readonly location: LocationPort;
  /** The device's Ed25519 signing key (05 §2.2) — the `SecureStoreKeyStore`, which satisfies this. */
  readonly signingKey: SigningKeyPort;
  /** Step 7's debounced sync hook (04 §5.1). At enrollment there is no loop yet, so a no-op is the
   *  honest binding — the genesis is durable the moment it commits, and the loop's boot sync (started
   *  by Root on enroll success) pushes it. Task 25's command runtime binds the real trigger. */
  readonly syncScheduler: SyncSchedulerPort;
}

export interface AppRuntime {
  /**
   * The permission evaluator, over the booted app's directory tables. Exposed so the composition root
   * can `prime()` it once the directory exists (02-permissions §6 bootstrap rule) and wire its
   * `onBundleRefresh` invalidation to the bundle refresh. Genesis is permission-EXEMPT (02 §4), so
   * the enrollment path uses `runtimeFor` without priming — the evaluator is inert there.
   */
  readonly evaluator: PermissionEvaluator;
  /**
   * A `CommandRuntime` for a device identity (the enroll response's tenant/store/device). Closes over
   * the shared op store, projection seam, evaluator and ports — only `device` varies per call. This
   * is the `EnrollmentDeps.runtimeFor` factory: `runEnrollment` calls it once to emit the genesis.
   */
  runtimeFor(device: DeviceIdentity): CommandRuntime;
}

/**
 * Compose the app's command runtime over the booted data layer.
 *
 * The op store and the projection seam are built ONCE here — one store over the one connection
 * (08 §2.2), one engine over the same registry — and closed over by `runtimeFor`, so every runtime
 * this app builds writes through the same append/projection atom (04 §5.1 steps 5–6).
 */
export function createAppRuntime(app: Bootstrapped, deps: AppRuntimeDeps): AppRuntime {
  const evaluator = new PermissionEvaluator(
    app.registry.permissions,
    createDirectorySource(app.db.db),
  );
  const store = createClientOpStore(app.db);
  const applyProjection = app.engine.asAppendSeam();

  return {
    evaluator,
    runtimeFor(device: DeviceIdentity): CommandRuntime {
      return createModuleRuntime<never>(app.registry, app.db.db as never, {
        device,
        evaluator,
        store,
        crypto: deps.crypto,
        clock: deps.clock,
        idSource: deps.idSource,
        location: deps.location,
        signingKey: deps.signingKey,
        applyProjection,
        syncScheduler: deps.syncScheduler,
        // Task 40's liveness bound, ACTIVATED here (task 102). The mechanism (`#recordBounded` in
        // core's enforcement point) is OFF unless a `RuntimeTimerPort` is wired: a denied command's
        // best-effort `auth.permission_denied` append is otherwise awaited UNBOUNDED, so a stuck
        // op-sqlite WAL lock on the one path an attacker can provoke at will (a denial) would wedge
        // `execute()` forever on-device. `systemTimer` — the app's single `setTimeout` binding, already
        // the sync loop's `TimerPort` — structurally satisfies `RuntimeTimerPort` (identical
        // `schedule(delayMs, fn) => cancel`), so this reuses it rather than adding a second timer
        // (§2.8). No budget override: the default `DENIAL_AUDIT_EMIT_TIMEOUT_MS` (2 s) applies. The deny
        // itself is NEVER conditional on the audit — a bounded-out emit is thrown-through regardless
        // (runtime/enforce.ts); this only stops it waiting FOREVER. Proven by runtime.test.ts, which
        // wedges when this line is removed.
        denialAuditTimer: systemTimer,
      }).commands;
    },
  };
}
