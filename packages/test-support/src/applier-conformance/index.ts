// The applier conformance suite (testing-guide T-8 / §2.4; 04-module-contract §2).
//
// 04 §2 requires appliers to be dialect-neutral and names the mechanism: "enforced by review + a
// shared test suite that runs every applier against both engines". §2.4 spells out the shape: fold
// a fixed seeded op script through the projection engine once against the SQLite shim and once
// against PGlite, dump both via the oracle, assert byte-equal digests. T-8 makes it a merge gate —
// "a module without this suite passing does not merge".
//
// WHY IT IS A SHARED FUNCTION AND NOT A COPY PER MODULE. Every module needs the identical
// procedure, and the procedure is where the subtlety lives (fold order, what "equal" means, whether
// the run proved anything). A per-module copy is how one module ends up comparing digests it never
// computed. This is CLAUDE.md §2.8 for test machinery.
//
// WHY THE ENGINES ARE INJECTED. `@bolusi/test-support` imports no DB driver (08 §3.3 hard rule 2 —
// "DB drivers are injected by the runner, never imported"). The runner hands over a `Kysely` per
// engine; this file is driver-agnostic and therefore also usable from the harness and, later, the
// device lane.
//
// ── WHAT MAKES THIS GATE LOAD-BEARING RATHER THAN DECORATIVE (CLAUDE.md §2.11, T-14) ──────────
//
// A digest-equality gate has one classic failure mode: comparing two digests that are equal because
// both runs did NOTHING. An empty table digests to the same string on both engines, so a suite that
// silently applied zero ops — a typo'd op type, a registry that never registered, a filter that
// matched nothing — reports a triumphant green. That is the "silently checks nothing" shape
// CLAUDE.md §2.11 calls worse than no guard.
//
// So this function ASSERTS ITS OWN DENOMINATOR and returns it for the caller to assert again:
//   * every op must be applied by a registered module on every engine (`unregistered` ⇒ throw);
//   * the op script must be non-empty;
//   * every engine must end with a non-zero row count;
//   * `result.rowCount` / `opsApplied` are returned so the calling test can pin real numbers.
// Digest equality is checked only after all of that holds.
import type { Kysely } from 'kysely';

import {
  createProjectionEngine,
  digestModule,
  ProjectionRegistry,
  type AnyModuleDefinition,
  type HashFn,
  type ModuleProjectionManifest,
  type ProjectionApplier,
} from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

/** One engine under test: a name for diagnostics and a Kysely handle the runner opened. */
export interface ApplierConformanceEngine<DB> {
  /** `'sqlite'` / `'postgres'` — appears in failure messages and in the returned digests. */
  readonly name: string;
  readonly db: Kysely<DB>;
}

export interface ApplierConformanceResult {
  /** engine name → oracle digest. Equal across engines is the assertion (§2.4). */
  readonly digests: ReadonlyMap<string, string>;
  /** Ops applied per engine — the denominator. Non-zero and identical by construction. */
  readonly opsApplied: number;
  /** engine name → projection row count after the fold. Non-zero, asserted below. */
  readonly rowCounts: ReadonlyMap<string, number>;
}

export interface ApplierConformanceOptions<DB> {
  readonly engines: readonly ApplierConformanceEngine<DB>[];
  /** The module whose appliers are under test (a `defineModule` result). */
  readonly module: AnyModuleDefinition<DB>;
  /** A fixed, seeded op script (§3.3) in the order it should be delivered. */
  readonly ops: readonly SignedOperation[];
  /** The oracle's hash (real SHA-256 — `noblePort.sha256`). */
  readonly hash: HashFn;
  /**
   * Insert one op into the engine's op-log table. Provided by the runner because the op-log DDL is
   * owned by db-client/db-server (10-db §9), not by this package.
   */
  readonly insertOp: (db: Kysely<DB>, op: SignedOperation) => Promise<void>;
  /** Count rows in the module's projection table(s) — the T-14b fixture assertion. */
  readonly countRows: (db: Kysely<DB>) => Promise<number>;
}

/**
 * Fold `ops` through the REAL projection engine on every engine and return the oracle digests.
 *
 * Uses the real `createProjectionEngine` + real appliers + real oracle (T-7) — a re-implementation
 * of the fold here would make the whole suite a test of this file.
 *
 * @throws when the run proves nothing (no ops, an unregistered op type, an empty projection) or
 *   when the digests disagree — with the disagreeing engines named.
 */
export async function runApplierConformance<DB>(
  options: ApplierConformanceOptions<DB>,
): Promise<ApplierConformanceResult> {
  const { engines, module, ops, hash, insertOp, countRows } = options;

  // ── denominator, before anything runs ────────────────────────────────────────────────────────
  if (engines.length < 2) {
    throw new Error(
      `applier conformance needs BOTH engines (testing-guide §2.4), got ${engines.length}: ${engines.map((e) => e.name).join(', ') || '(none)'}. One engine cannot prove dialect-neutrality.`,
    );
  }
  if (ops.length === 0) {
    throw new Error(
      'applier conformance was handed an EMPTY op script — an empty projection digests identically on every engine, so this run would be green having proved nothing (T-14).',
    );
  }

  const projectionManifest = toProjectionManifest(module);
  const digests = new Map<string, string>();
  const rowCounts = new Map<string, number>();
  let opsApplied = -1;

  for (const engine of engines) {
    const registry = new ProjectionRegistry<DB>();
    registry.register(projectionManifest);
    const projection = createProjectionEngine(engine.db, registry);

    let applied = 0;
    for (const op of ops) {
      // The faithful delivery discipline the engine assumes (05 §5): the op is in the log BEFORE
      // its apply, because the engine reads the log to decide head vs re-fold (04 §4.2).
      await insertOp(engine.db, op);
      const outcome = await projection.applyAppendedOp(op);

      // An op no module claims is the silent-nothing failure: it would leave the projection empty
      // and every engine would agree about that emptiness.
      if (outcome.mode === 'unregistered') {
        throw new Error(
          `op type ${op.type} is not registered by module ${module.id} on engine ${engine.name} — the fold would silently skip it and every engine would agree on the resulting emptiness (T-14).`,
        );
      }
      applied += 1;
    }

    if (opsApplied !== -1 && applied !== opsApplied) {
      throw new Error(
        `engine ${engine.name} applied ${applied} ops but a previous engine applied ${opsApplied} — the engines were not handed the same work, so a digest comparison would be meaningless.`,
      );
    }
    opsApplied = applied;

    const rows = await countRows(engine.db);
    if (rows === 0) {
      throw new Error(
        `engine ${engine.name} has an EMPTY projection after folding ${applied} ops — an empty table digests identically everywhere, so equality here would prove nothing (T-14b: assert the fixture before believing the result).`,
      );
    }
    rowCounts.set(engine.name, rows);

    digests.set(engine.name, await digestModule(engine.db, projectionManifest, { hash }));
  }

  // ── the actual assertion (§2.4): byte-equal oracle digests ───────────────────────────────────
  const [reference, ...rest] = [...digests.entries()];
  if (reference === undefined) throw new Error('no engines produced a digest');
  for (const [name, digest] of rest) {
    if (digest !== reference[1]) {
      throw new Error(
        `applier conformance FAILED (04 §2 / T-8): module ${module.id} produced different projections on ${reference[0]} and ${name}.\n` +
          `  ${reference[0]}: ${reference[1]}\n  ${name}: ${digest}\n` +
          `An applier must be dialect-neutral — the same ops must fold to byte-identical rows on SQLite and Postgres. A difference here means a device and the server disagree about the same history.`,
      );
    }
  }

  return { digests, opsApplied, rowCounts };
}

/** The projection-facing slice (04 §4) — the same mapping `registerModules` makes. */
function toProjectionManifest<DB>(module: AnyModuleDefinition<DB>): ModuleProjectionManifest<DB> {
  const appliers: Record<string, ProjectionApplier<DB>> = {};
  for (const [type, declaration] of Object.entries(module.operations)) {
    appliers[type] = declaration.apply;
  }
  return { id: module.id, tables: module.projections.tables, appliers };
}
