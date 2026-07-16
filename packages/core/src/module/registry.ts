// Module registration (04-module-contract §1/§3/§4; 02-permissions §3.2) — assembly, and the
// STARTUP FAILURES that are the point of it.
//
// ── ASSEMBLY IS A FAILURE SURFACE, NOT A WARNING SURFACE ──────────────────────────────────────
//
// 02 §3.2 says "startup failure (not a warning)" and means it. Every rule here is checked before
// the first command runs, because each defect degrades into something that looks like normal
// operation:
//
//   duplicate permission id     → two modules disagree about what one string means; the winner is
//                                 module-registration order, i.e. an import-order coincidence.
//   unresolvable permission     → the evaluator denies `unknown_permission` on every call forever
//                                 (02 §5.2 step 1). A permanent outage wearing an authorization
//                                 decision's clothes — the UI says "you don't have permission",
//                                 and nobody looks for a registry bug.
//   duplicate op type           → one applier silently shadows another; the loser's projection
//                                 never updates and its module looks broken at random.
//   duplicate module id         → re-registration would merge or shadow. Both are worse than a
//                                 crash, because both are silent.
//
// Failing the boot is the loud version of facts that are already true.
//
// ── WHAT THIS FILE DOES NOT RE-IMPLEMENT ──────────────────────────────────────────────────────
//
// The permission-registry rules (02 §3.2 rules 1–4) belong to `authz/registry.ts` (task 09) and are
// CALLED here, not restated. The op-type→applier maps belong to `projection/registry.ts` (task 08)
// and are likewise called. This file's own contribution is the operation registry (04 §3) and the
// composition — one module list feeding three registries that previously had no common entry point
// (CLAUDE.md §2.8).
import {
  assemblePermissionRegistry,
  type ModulePermissionManifest,
  type PermissionDeclaration,
  type PermissionRegistry,
} from '../authz/registry.js';
import { ProjectionRegistry } from '../projection/registry.js';
import type {
  ModuleProjectionManifest,
  ProjectionApplier,
  ProjectionDb,
} from '../projection/manifest.js';
import type {
  AnyCommandDeclaration,
  AnyQueryDeclaration,
  ConflictDeclaration,
  ModuleProjections,
  OperationDeclaration,
  OperationScope,
} from './define-module.js';

/** A registration defect (04 §1/§3; 02 §3.2). Thrown at assembly — before the first command. */
export class ModuleRegistryError extends Error {
  override readonly name = 'ModuleRegistryError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Any defined module, with its per-command/query types erased for storage in a list.
 *
 * Declared structurally rather than as `ModuleDefinition<DB, ModuleManifest<DB>>`: `DB` sits in a
 * contravariant position (`apply(db: Kysely<DB>, …)`), so the derived form makes two concrete
 * modules over the same `DB` mutually unassignable and a `readonly AnyModuleDefinition<DB>[]`
 * impossible to build. The shape below is what assembly actually reads, and every `defineModule`
 * result satisfies it structurally.
 */
export interface AnyModuleDefinition<DB> {
  readonly id: string;
  readonly operations: Readonly<Record<string, OperationDeclaration<DB>>>;
  readonly projections: ModuleProjections<DB>;
  readonly commands?: Readonly<Record<string, AnyCommandDeclaration & { readonly name: string }>>;
  readonly queries?: Readonly<Record<string, AnyQueryDeclaration & { readonly name: string }>>;
  readonly permissions?: Readonly<Record<string, PermissionDeclaration>>;
}

/**
 * The operation registry (04 §3) — op type → its declared `schemaVersion`.
 *
 * THIS IS THE RESOLUTION OF TASK 10's `ctx.op()` STOPGAP. Task 10 shipped `OpDraftInput` with an
 * optional `schemaVersion` defaulting to `1`, marked "LOCAL STOPGAP — task 11" and explicitly
 * instructed to be DELETED rather than kept alongside a second answer (CLAUDE.md §2.8). The field
 * is now gone from `OpDraftInput`: a handler cannot state a version, because the version is not the
 * handler's to state. 04 §3 says the REGISTRY declares the current `schemaVersion` per op type, and
 * a handler that could override it could emit an op claiming a shape it does not have — which the
 * applier would then mis-fold forever, since old ops never disappear (05 §7).
 */
export interface OperationRegistry {
  /** The declared version for an op type, or `undefined` when no module declares it. */
  schemaVersionFor(type: string): number | undefined;
  /**
   * The declared envelope scope for an op type (01 §6; 05 §2.1), or `undefined` when no module
   * declares the type. Declared types default to `'store'`.
   *
   * Same rationale as `schemaVersionFor`: the scope is a property of the TYPE, so the runtime
   * resolves it here rather than letting a handler state it per emission.
   */
  scopeFor(type: string): OperationScope | undefined;
  /**
   * The declared conflict rule for an op type (01 §8.1), or `undefined` when the type declares
   * none (⇒ it never produces a Conflict record). The server's Rule-1 detection reads this.
   */
  conflictFor(type: string): ConflictDeclaration | undefined;
  /** Every registered op type, sorted. The T-14 denominator for any sweep over op types. */
  types(): readonly string[];
  readonly size: number;
}

/** The assembled registry set for a build's modules. */
export interface ModuleRegistry<DB> {
  readonly modules: readonly AnyModuleDefinition<DB>[];
  /** 02 §3 — the permission vocabulary (assembled by task 09's `assemblePermissionRegistry`). */
  readonly permissions: PermissionRegistry;
  /** 04 §4 — op type → applier, ready for `createProjectionEngine` (task 08). */
  readonly projections: ProjectionRegistry<DB>;
  /** 04 §3 — op type → declared schemaVersion. */
  readonly operations: OperationRegistry;
  /** A command by `<moduleId>.<name>`, or undefined. */
  command(qualifiedName: string): unknown;
  /** A query by `<moduleId>.<name>`, or undefined. */
  query(qualifiedName: string): unknown;
  /** Every `<moduleId>.<name>` command key, sorted — a sweep's denominator (T-14). */
  commandNames(): readonly string[];
  /** Every `<moduleId>.<name>` query key, sorted — a sweep's denominator (T-14). */
  queryNames(): readonly string[];
}

/**
 * Assemble the registries from a build's modules (04 §1; 02 §3.2).
 *
 * @throws {ModuleRegistryError} duplicate module id, duplicate op type across modules.
 * @throws {import('../authz/registry.js').PermissionRegistryError} 02 §3.2 rules 1–4 — duplicate
 *   permission id, unresolvable command/query permission, wrong id prefix.
 */
export function registerModules<DB>(
  modules: readonly AnyModuleDefinition<DB>[],
): ModuleRegistry<DB> {
  // Duplicate module id, checked FIRST and here rather than being left to the sub-registries.
  //
  // Both sub-registries would also catch it, but each would report it in its own vocabulary
  // ("module already registered" from whichever ran first), and — the real reason — a module with
  // no permissions and no appliers would be caught by NEITHER. Re-registration is an error, never
  // a silent merge (04 §1: module ids are unique).
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.id)) {
      throw new ModuleRegistryError(
        `module ${module.id} is registered twice — module ids are unique (04 §1). Re-registration is an error, not a merge: two manifests under one id would have their op types, permissions and tables silently combined in import order.`,
      );
    }
    seen.add(module.id);
  }

  // 02 §3.2 rules 1–4, by task 09's assembler. The manifests are handed over as the authz-facing
  // slice it declares — `permissions` plus the commands/queries whose `permission` must resolve.
  const permissionManifests: ModulePermissionManifest[] = modules.map((module) => ({
    id: module.id,
    ...(module.permissions === undefined ? {} : { permissions: module.permissions }),
    ...(module.commands === undefined ? {} : { commands: module.commands }),
    ...(module.queries === undefined ? {} : { queries: module.queries }),
  }));
  const permissions = assemblePermissionRegistry(permissionManifests);

  // 04 §4 — appliers into task 08's registry. It throws on a duplicate op type across modules
  // (04 §1: op types are module-prefixed and globally unique), which is why that rule is not
  // restated here.
  const projections = new ProjectionRegistry<DB>();
  for (const module of modules) {
    projections.register(toProjectionManifest(module));
  }

  // 04 §3 — the operation registry. One pass, three facts per type: they come from ONE
  // declaration, so they cannot disagree about which types exist (CLAUDE.md §2.8).
  const schemaVersions = new Map<string, number>();
  const scopes = new Map<string, OperationScope>();
  const conflicts = new Map<string, ConflictDeclaration>();
  for (const module of modules) {
    for (const [type, declaration] of Object.entries(module.operations)) {
      schemaVersions.set(type, declaration.schemaVersion);
      // Default here, once, rather than at each reader: an absent `scope` means 'store' (01 §6),
      // and a reader that had to remember that is how the two answers drift apart.
      scopes.set(type, declaration.scope ?? 'store');
      if (declaration.conflict !== undefined) conflicts.set(type, declaration.conflict);
    }
  }

  const commands = new Map<string, unknown>();
  const queries = new Map<string, unknown>();
  for (const module of modules) {
    for (const [name, declaration] of Object.entries(module.commands ?? {})) {
      commands.set(`${module.id}.${name}`, declaration);
    }
    for (const [name, declaration] of Object.entries(module.queries ?? {})) {
      queries.set(`${module.id}.${name}`, declaration);
    }
  }

  const operations: OperationRegistry = {
    schemaVersionFor: (type) => schemaVersions.get(type),
    // Keyed off `schemaVersions` membership, not off `scopes`, so an undeclared type answers
    // `undefined` (the caller's fail-closed signal) rather than the 'store' default.
    scopeFor: (type) => (schemaVersions.has(type) ? (scopes.get(type) ?? 'store') : undefined),
    conflictFor: (type) => conflicts.get(type),
    types: () => [...schemaVersions.keys()].sort(),
    get size() {
      return schemaVersions.size;
    },
  };

  return {
    modules,
    permissions,
    projections,
    operations,
    command: (name) => commands.get(name),
    query: (name) => queries.get(name),
    commandNames: () => [...commands.keys()].sort(),
    queryNames: () => [...queries.keys()].sort(),
  };
}

/** The projection-facing slice (04 §4) task 08's engine consumes: id, tables, type → applier. */
function toProjectionManifest<DB>(module: AnyModuleDefinition<DB>): ModuleProjectionManifest<DB> {
  const appliers: Record<string, ProjectionApplier<DB>> = {};
  for (const [type, declaration] of Object.entries(module.operations)) {
    appliers[type] = declaration.apply;
  }
  return { id: module.id, tables: module.projections.tables, appliers };
}

/**
 * Run every module's declared projection migrations, in declaration order (04 §4.4).
 *
 * DELIBERATELY NOT A MIGRATION SYSTEM. There is no bookkeeping table, no "which ran already", no
 * resume — this brings a FRESH database up to the declared shape, which is what the test harnesses
 * and the applier conformance suite need. Real migration orchestration (ordering against the app's
 * own migrations, recording what ran, upgrade paths) belongs to `@bolusi/db-client` /
 * `@bolusi/db-server` (10-db §9), and a second one here would be a second source of truth about the
 * database's shape (CLAUDE.md §2.8). Run it against a database that already has these tables and it
 * will fail exactly as a duplicate `CREATE TABLE` should.
 */
export async function applyModuleMigrations<DB>(
  db: ProjectionDb<DB>,
  modules: readonly AnyModuleDefinition<DB>[],
): Promise<number> {
  let applied = 0;
  for (const module of modules) {
    for (const migration of module.projections.migrations ?? []) {
      await migration.up(db);
      applied += 1;
    }
  }
  return applied;
}
