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
  type ClockPort,
  type CommandContext,
  type CommandDefinition,
  type LocationPort,
  type ModuleRuntime,
  type ProjectionEngine,
  type SigningKeyPort,
  type SyncSchedulerPort,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { createClientOpStore } from '@bolusi/db-client';
import { notesModule, notesModuleManifest } from '@bolusi/modules/notes';
import type { SignedOperation } from '@bolusi/schemas';
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

export class VirtualDevice {
  #serverSeqSeen = 0;

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
  }): Promise<VirtualDevice> {
    const { identity, clock, prng } = options;
    const handle = await openClientDb();

    const registry = registerModules<ClientDatabase>([
      notesModule as unknown as AnyModuleDefinition<ClientDatabase>,
    ]);
    const stats = new ProjectionStats();
    const engine = createProjectionEngine(handle.db, registry.projections, { stats });

    const evaluator = await buildGrantAllEvaluator({
      tenantId: identity.tenantId,
      userId: identity.userId,
      manifests: [notesModuleManifest],
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
    mediaId?: string | null;
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
   * assigned `serverSeq` is monotonic per delivery order into THIS device.
   */
  async applyForeign(op: SignedOperation): Promise<ApplyMode> {
    this.#serverSeqSeen += 1;
    await insertPulledOp(this.handle.db, op, this.#serverSeqSeen, this.clock.now());
    const outcome = await this.engine.applyPulledOp(op);
    return outcome.mode;
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
