// A VirtualDevice (testing-guide §3.1): its OWN SQLite behind the shim (one connection), a
// seed-derived Ed25519 identity, an independently-skewable FakeClock, and the REAL `@bolusi/core`
// command runtime + projection engine (T-7 — the harness owns no protocol logic). Authoring goes
// through the production `execute` → append (JCS + SHA-256 + Ed25519) → project → commit path; a
// foreign op is applied through the REAL engine's pull path (`applyPulledOp`), which is what makes
// out-of-order arrival converge (04 §4.2) and what CHAOS-01 measures via `engine.stats`.
import {
  createModuleRuntime,
  createProjectionEngine,
  digestModule,
  ProjectionStats,
  registerModules,
  type AnyModuleDefinition,
  type ApplyMode,
  type ApplyOutcome,
  type ClockPort,
  type CommandContext,
  type CommandDefinition,
  type LocationPort,
  type ModulePermissionManifest,
  type ModuleRuntime,
  type ProjectionEngine,
  type RebuildOutcome,
  type RunRebuildOptions,
  type SigningKeyPort,
  type SyncSchedulerPort,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { createClientOpStore } from '@bolusi/db-client';
import { notesModule, notesModuleManifest } from '@bolusi/modules/notes';
import type { MediaRef, SignedOperation } from '@bolusi/schemas';
import type { FakeClock } from '@bolusi/test-support';
import { makeIdSource, noblePort, type Prng } from '@bolusi/test-support';

import { insertPulledOp, openClientDb, readWireOps, type ClientDbHandle } from './client-db.js';
import { notesProjectionManifest } from './manifest.js';
import { buildGrantAllEvaluator } from './permissions.js';

/** A device's deterministic identity (§3.1). Tenant + store are shared across a run's devices. */
export interface DeviceIdentity {
  readonly tenantId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly deviceId: string;
  /** The RFC-8032 seed = SHA-256(harnessSeed ‖ deviceIndex) — `SigningKeyPort.getSigningKey()`. */
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly publicKeyBase64: string;
}

const GENESIS_OP_TYPE = 'auth.device_enrolled';

/**
 * A module to register on a device BEYOND `notes` (which is always registered), paired with its
 * permission manifest for the grant-all evaluator. CHAOS-07 adds `platform` so a device can fold the
 * server-minted `platform.conflict_detected` op into its `conflicts` projection and author
 * `platform.conflict_acknowledged` through the real `acknowledgeConflict` command (04 §5.1 — the
 * only production write path). Every other scenario is notes-only, so this defaults to empty.
 */
export interface ExtraModule {
  readonly module: AnyModuleDefinition<ClientDatabase>;
  readonly permissionManifest: ModulePermissionManifest;
}

export class VirtualDevice {
  #arrivalSeqSeen = 0;

  private constructor(
    readonly identity: DeviceIdentity,
    readonly clock: FakeClock,
    /** The engine's stats sink — head-apply vs re-fold counters (CHAOS-01, §4.2). */
    readonly stats: ProjectionStats,
    private readonly handle: ClientDbHandle,
    private readonly runtime: ModuleRuntime<ClientDatabase>,
    private readonly engine: ProjectionEngine<ClientDatabase>,
  ) {}

  get db() {
    return this.handle.db;
  }

  /**
   * Wire a device: real client DB + migrations, the real engine (with a stats sink), the real
   * command/query runtimes over a grant-all evaluator, then the genesis enrollment op so the
   * device can command (05 §9.5). `prng` seeds the id source; `clock` is the ONLY time source.
   */
  static async open(options: {
    readonly identity: DeviceIdentity;
    readonly clock: FakeClock;
    readonly prng: Prng;
    /** Modules to register beyond `notes` (CHAOS-07 adds `platform`). Default: none. */
    readonly extraModules?: readonly ExtraModule[];
  }): Promise<VirtualDevice> {
    const { identity, clock, prng } = options;
    const extraModules = options.extraModules ?? [];
    const handle = await openClientDb();

    const registry = registerModules<ClientDatabase>([
      notesModule as unknown as AnyModuleDefinition<ClientDatabase>,
      ...extraModules.map((m) => m.module),
    ]);
    const stats = new ProjectionStats();
    const engine = createProjectionEngine(handle.db, registry.projections, { stats });

    const evaluator = await buildGrantAllEvaluator({
      tenantId: identity.tenantId,
      userId: identity.userId,
      manifests: [notesModuleManifest, ...extraModules.map((m) => m.permissionManifest)],
    });

    const clockPort: ClockPort = { now: () => clock.now() };
    const signingKey: SigningKeyPort = { getSigningKey: () => identity.seed };
    const location: LocationPort = { getBestFix: () => null };
    const syncScheduler: SyncSchedulerPort = { schedule: () => undefined };

    const runtime = createModuleRuntime(registry, handle.db, {
      device: {
        tenantId: identity.tenantId,
        storeId: identity.storeId,
        deviceId: identity.deviceId,
      },
      evaluator,
      store: createClientOpStore({ db: handle.db, driver: handle.driver }),
      crypto: noblePort,
      clock: clockPort,
      idSource: makeIdSource(clock, prng),
      location,
      signingKey,
      applyProjection: async (op) => {
        await engine.applyAppendedOp(op);
      },
      syncScheduler,
    });

    const device = new VirtualDevice(identity, clock, stats, handle, runtime, engine);

    // Genesis (05 §9.5): enroll before the first command, exactly as production bootstrap does. The
    // payload is the real `auth.device_enrolled` shape (auth/module.ts) so the chain's seq-1 op
    // validates when the device pushes it to the server (api/02-auth §6.2).
    await runtime.commands.emitRuntimeOp({
      type: GENESIS_OP_TYPE,
      entityType: 'device',
      entityId: identity.deviceId,
      payload: {
        storeId: identity.storeId,
        deviceName: 'device',
        devicePublicKeyB64: identity.publicKeyBase64,
      },
      userId: identity.userId,
    });

    return device;
  }

  #ctx(): CommandContext {
    return this.runtime.commands.createContext(this.identity.userId);
  }

  #command(name: string): CommandDefinition<unknown, unknown> {
    const declaration = this.runtime.registry.command(name);
    if (declaration === undefined) {
      throw new Error(`command not registered: ${name}`);
    }
    return declaration as unknown as CommandDefinition<unknown, unknown>;
  }

  /** Author a note via the production path. Returns the minted note id. */
  async createNote(input: {
    title: string;
    body: string;
    /** The whole signed `mediaRef` at schemaVersion 3 — a bare id can no longer be attached, because
     *  a note pulled by another device would have no hash to verify its photo against (06 §6). */
    mediaRef?: MediaRef | null;
  }): Promise<string> {
    const outcome = await this.runtime.commands.execute(
      this.#command('notes.createNote'),
      input,
      this.#ctx(),
    );
    return (outcome.result as { noteId: string }).noteId;
  }

  async editNote(noteId: string, body: string): Promise<void> {
    await this.runtime.commands.execute(
      this.#command('notes.editNoteBody'),
      { noteId, body },
      this.#ctx(),
    );
  }

  async archiveNote(noteId: string): Promise<void> {
    await this.runtime.commands.execute(
      this.#command('notes.archiveNote'),
      { noteId },
      this.#ctx(),
    );
  }

  /**
   * Apply a foreign op through the REAL pull path: insert it (synced) then fold it via the engine's
   * `applyPulledOp`, whose head/re-fold dispatch (04 §4.2) is exactly what CHAOS-01 measures. The
   * assigned `arrival_seq` is monotonic per delivery order into THIS device (10-db §9.2, D20 §4).
   */
  async applyForeign(op: SignedOperation): Promise<ApplyMode> {
    this.#arrivalSeqSeen += 1;
    await insertPulledOp(this.handle.db, op, this.#arrivalSeqSeen, this.clock.now());
    const outcome = await this.engine.applyPulledOp(op);
    return outcome.mode;
  }

  /**
   * Run `fn` in ONE transaction on this device's SINGLE connection (§2.3) — the seam the real
   * `runPullPhase` requires (its whole contract is "the batch is one transaction", sync/pull.ts).
   * Driver-level BEGIN/COMMIT so the engine's `db`, the pull phase's `db`, and this transaction all
   * share the one connection, exactly as the production wiring and core's own sync harness do.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.handle.driver.begin();
    try {
      const result = await fn();
      await this.handle.driver.commit();
      return result;
    } catch (error) {
      await this.handle.driver.rollback();
      throw error;
    }
  }

  /** The engine's pull-apply seam (04 §4.2 head/re-fold), for the REAL `runPullPhase` (CHAOS-02/12). */
  pullApply(op: SignedOperation): Promise<ApplyOutcome> {
    return this.engine.applyPulledOp(op);
  }

  /** Run (or resume) a full projection rebuild via the REAL engine (04 §4.3) — CHAOS-08 drives this. */
  rebuild(moduleId: string, options?: RunRebuildOptions): Promise<RebuildOutcome> {
    return this.engine.rebuild(moduleId, options);
  }

  /** Every op this device holds (its own authored ops + any applied foreign ops), wire shape. */
  wireOps(): Promise<SignedOperation[]> {
    return readWireOps(this.handle.db);
  }

  /** The notes-projection digest (§3.4) — byte-equal iff converged. */
  digest(): Promise<string> {
    return digestModule(this.handle.db, notesProjectionManifest, {
      hash: (d) => noblePort.sha256(d),
    });
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}
