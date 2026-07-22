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
  type ModuleRuntime,
  type SigningKeyPort,
  type SyncSchedulerPort,
} from '@bolusi/core';
import { createClientOpStore, type ClientDatabase } from '@bolusi/db-client';

import type { Bootstrapped } from './bootstrap.js';
import { denialAuditDiagnostics } from '../ports/diagnostics.js';
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
  /**
   * The SAME composition, with its query runtime still attached (task 119).
   *
   * `runtimeFor` returns only `.commands` because enrollment only ever appends. A module SCREEN reads
   * as well as writes, and 04 §6's read enforcement lives in the query runtime — so the notes runtime
   * needs the whole `ModuleRuntime`, not half of it. This is deliberately the same
   * `createModuleRuntime` call rather than a second one: `createModuleRuntime`'s own header explains
   * that composing the command/query knot twice is how a build ends up with TWO enforcement points,
   * one of which nobody primes. Exposing the object instead of rebuilding it makes "the reads and the
   * writes are enforced by the same evaluator" true by construction (§2.8).
   */
  moduleRuntimeFor(device: DeviceIdentity): ModuleRuntime<ClientDatabase>;
  /**
   * Point step 7 (04 §5.1 — "schedule sync (debounced)") at the live loop's append trigger, or
   * `null` to detach it on teardown (task 136).
   *
   * ── WHY THIS IS A LATE BIND AND NOT A CONSTRUCTOR ARGUMENT ────────────────────────────────────
   * There is a genuine construction-order cycle. The command runtime must exist BEFORE any sync loop
   * does: `runEnrollment` appends the genesis op through it (api/02-auth §4.1 step 6), and that
   * append is what persists the `deviceId` a `SyncClient` requires to be constructed at all. So at
   * the instant this composition is built there is nothing to bind, and whatever is bound then is
   * what every later command gets — which is exactly how the shipping app came to call
   * `{ schedule: () => undefined }` after EVERY local append, forever, while the real
   * `createSyncTriggers(...).scheduler` sat with zero production consumers.
   *
   * Binding late is the one shape that lets the SAME runtime serve the genesis (no loop yet) and
   * every note/session command afterwards (loop live) without a second composition. `Root` calls it
   * in exactly one place — where it constructs the client — and the guard on that call is
   * `test/live-shell-sync-scheduler.test.tsx`, which creates a note through the mounted app and
   * watches the debounced cycle carry it. Delete the bind and that test reds; this comment is not
   * the evidence (§2.11), that test is.
   */
  bindSyncScheduler(scheduler: SyncSchedulerPort | null): void;
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

  /**
   * Step 7's hook, indirected so it can be pointed at the loop once one exists (see
   * `bindSyncScheduler`). Every `CommandRuntime` this composition mints closes over THIS object, so
   * one bind reaches the genesis path, the session ops and every module command at once.
   *
   * Unbound it does nothing — which is correct for the only window in which it is unbound (before
   * enrollment there is no loop and nothing to sync to) and is a bug in every other window. That
   * asymmetry is why the bind is guarded by a composed test rather than by this comment.
   */
  let boundScheduler: SyncSchedulerPort | null = null;
  const syncScheduler: SyncSchedulerPort = {
    schedule(): void {
      boundScheduler?.schedule();
    },
  };

  return {
    evaluator,
    bindSyncScheduler(next: SyncSchedulerPort | null): void {
      boundScheduler = next;
    },
    runtimeFor(device: DeviceIdentity): CommandRuntime {
      return this.moduleRuntimeFor(device).commands;
    },
    moduleRuntimeFor(device: DeviceIdentity): ModuleRuntime<ClientDatabase> {
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
        syncScheduler,
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
        // Task 99's surfacing, ACTIVATED here (task 112) — same shape as the line above, one task
        // later. The denial-audit emit is best-effort by design (a decided denial is not un-decided
        // because its record failed to append), so core SWALLOWS an append failure and throws
        // PERMISSION_DENIED regardless. Correct for the decision — but the swallow is also SILENT
        // unless a sink is wired, so a PERSISTENTLY failing append (full disk, corrupt DB, migration
        // drift) makes the FR-1045 trail quietly incomplete with nothing able to notice. Absent =
        // pre-task-99 behaviour byte-for-byte, which is exactly what the app shipped until now.
        // `denialAuditDiagnostics` is the app's ONE client diagnostics channel (ports/diagnostics.ts),
        // the same object `bootstrapI18n` binds as the `I18nLogger` (§2.8 — one channel, not two).
        // It NEVER affects the denial: the record is surfaced and the deny is thrown either way, and
        // core guards the sink call so even a throwing sink cannot change a decided denial.
        // Proven by runtime.test.ts, which stops observing the loss when this line is removed.
        denialAuditDiagnostics,
      }) as unknown as ModuleRuntime<ClientDatabase>;
    },
  };
}
