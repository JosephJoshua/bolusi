// `defineModule` (04-module-contract §1) — the contract every module implements, and the gate that
// makes a malformed manifest a STARTUP FAILURE rather than a runtime surprise.
//
// WHY VALIDATION LIVES HERE AND IS LOUD. A manifest is static data, evaluated at import time, so
// every defect it can carry is knowable before the first command runs — a present-tense op type, a
// payload that silently strips unknown keys, a missing `reversal`. The alternative to throwing is
// discovering it from a production op log that is append-only and therefore permanent (05 §7: old
// ops never disappear). 04 §3 has no "warning" state and neither does this file.
//
// SCOPE: this validates the manifest STANDALONE — everything answerable from one module's own
// declaration. Cross-module facts (duplicate permission ids, duplicate op types across modules,
// a `permission` that resolves to nothing) belong to assembly, where the other modules are in
// scope: `module/registry.ts` + `authz/registry.ts` (02 §3.2 rules 1–4).
import type { PermissionDeclaration } from '../authz/registry.js';
import type {
  ProjectionApplier,
  ProjectionDb,
  ProjectionTableManifest,
} from '../projection/manifest.js';
import type { CommandContext, InputParser } from '../runtime/ctx.js';
import type { CommandHandlerResult } from '../runtime/execute.js';
import type { QueryContext, QueryPage } from '../query/qctx.js';
import { checkOpType } from './op-type.js';
import { isStrictSchema } from './strict-schema.js';

/** A manifest defect (04 §3/§4.4). Thrown by `defineModule` — at import time, never at runtime. */
export class ModuleDefinitionError extends Error {
  override readonly name = 'ModuleDefinitionError';
  constructor(message: string) {
    super(message);
  }
}

/** Conflict severity (01 §8.3). Static per op type — v0 has no payload-dependent severity. */
export type ConflictSeverity = 'minor' | 'significant';

/**
 * A conflict declaration (01-domain-model §8.1, which extends 04 §3).
 *
 * `conflict: { key: 'note.body', severity: 'minor' }` — OPTIONAL. "Ops without a `conflict`
 * declaration never generate Conflict records. Two ops conflict only when they share (`entityId`,
 * `conflict.key`)" (§8.1). The server's Rule-1 detection reads exactly this: it is the only thing
 * that makes two accepted ops on one entity a collision rather than a sequence.
 *
 * `severity` is STATIC (§8.3: "an op type's declared severity is static — v0 has no
 * payload-dependent severity"), which is why it lives on the type's declaration and not in a
 * payload field an emitter could vary.
 *
 * OWNING-DOC NOTE: 01 §8.1 declares this field and frames itself as extending 04 §3 — but 04 §3's
 * registry-entry shape does not list it (04 lists `permissions`, which 02 §3.2 obliges it to). The
 * field is implemented here per 01 §8.1; the 04 §3 shape listing is stale. Spec drift is its own
 * task (CLAUDE.md §4) — filed, not fixed here.
 */
export interface ConflictDeclaration {
  /** Which aspect collides (01 §5.4 `conflictKey`), e.g. `note.body`. */
  readonly key: string;
  /** The Conflict record's severity when this rule fires (01 §8.3). */
  readonly severity: ConflictSeverity;
}

/**
 * The envelope scope an op type is recorded in (05 §2.1: `storeId` null = tenant-scoped).
 *
 * Declared on the TYPE for the same reason `schemaVersion` is (see below): it is a property of the
 * op type, not of the emission. 01 §6 pins it per type — `platform.user_locale_changed` is
 * "Tenant-scoped (`storeId = null`): the preference follows the user to every device", while every
 * `auth.*`/`notes.*` op is store-scoped. A handler that could state its own scope could record an
 * op in a store it was not authorized in; the registry states it once instead.
 *
 * Default `'store'` — the device's store (02 §5.2's v0 rule), which is what every op type declared
 * before this field existed already got, so omitting it is exactly the previous behaviour.
 *
 * OWNING-DOC NOTE: 01 §6 states the FACT (this type's `storeId` is null) but names no mechanism,
 * and 04 §5's runtime stamps `storeId` from the device identity for every draft — so the fact was
 * previously inexpressible. Filed as spec drift alongside `conflict` (CLAUDE.md §4).
 */
export type OperationScope = 'store' | 'tenant';

/**
 * One declared op type (04 §3).
 *
 * `reversal` is MANDATORY and documentation-only in v0 (04 §3 / 05 §7): "how is this undone?" is a
 * question with an answer at design time and no answer at 2am, so the contract forces it to be
 * written while the author still knows. An executable `buildReversal` slots in for V2 without a
 * contract change.
 */
export interface OperationDeclaration<DB> {
  /** Current payload version (04 §3). Integer ≥ 1; bumping it is a new version, never an edit. */
  readonly schemaVersion: number;
  /** `.strict()` payload schema (04 §3) — unknown keys rejected. Probed, not trusted. */
  readonly payload: InputParser<unknown>;
  /**
   * RETAINED payload schemas for every SUPERSEDED version (04 §3), keyed by version — so the pair
   * (`type`, `schemaVersion`) that 05 §8 names as the unit of payload validation actually HAS a
   * schema for every foldable version, not just the current one.
   *
   * MANDATORY and COMPLETE whenever `schemaVersion > 1`: keys must be exactly `1 .. schemaVersion-1`
   * (`validateOperations` fails the boot otherwise). Omit it entirely at `schemaVersion: 1`, where
   * `payload` already covers the only version that exists.
   *
   * ── WHY RETENTION IS PART OF THE CONTRACT AND NOT AN OPTIONAL EXTRA (task 127) ────────────────
   *
   * Bumping a version does not retire the old one: old ops never disappear (05 §7), so the applier
   * must fold `1..current` forever — and a version the applier folds is a version the server will
   * be ASKED to accept. With only the current schema retained, the server had exactly two options
   * for an old version, and both were wrong. Validating an old payload against the CURRENT schema
   * rejects legitimate old clients (a v2 `note_created` carries `mediaId`, which v3's `.strict()`
   * refuses). Skipping validation accepts ANY payload at an old version — which is what shipped:
   * the op entered the signed, append-only log unvalidated and the applier threw at FOLD time,
   * inside the push transaction, taking the whole batch down as a `500` (poisoning honest sibling
   * ops, security-guide §4.1) and wedging the pushing device forever, because the client reads a
   * 500 as a transport failure and re-sends the identical batch. Retaining the schemas is the only
   * option that is neither too tight nor open: each version is checked against what IT declared.
   *
   * A retained schema is `.strict()` like any other (04 §3) — otherwise "claim an old version"
   * would remain a blanket bypass of the unknown-key rule for every type past v1.
   */
  readonly payloadByVersion?: Readonly<Record<number, InputParser<unknown>>>;
  /** MANDATORY prose: how this op is reversed (04 §3, 05 §7). */
  readonly reversal: string;
  /** The fold step (04 §4.1). */
  readonly apply: ProjectionApplier<DB>;
  /** Optional collision declaration (01 §8.1). Absent ⇒ this type never produces a Conflict. */
  readonly conflict?: ConflictDeclaration;
  /** Envelope scope (01 §6; 05 §2.1). Default `'store'`. */
  readonly scope?: OperationScope;
}

/**
 * The payload schema that validates `schemaVersion` for this op type (04 §3; 05 §8), or `undefined`
 * when the declaration retains none.
 *
 * `undefined` is the FAIL-CLOSED answer and callers must treat it as one: the version is either
 * unfoldable (`> current`, or not an integer ≥ 1 — never declared, no applier branch, 05 §2.1) or
 * foldable-but-unretained, which `defineModule` makes unreachable for a registered module and which
 * is still refused here rather than waved through. There is no "no schema ⇒ accept" branch, because
 * that branch IS task 127's defect.
 *
 * Deliberately a free function over the declaration rather than a method on it: manifests are plain
 * data (`defineModule` returns them by reference), and a method would have to be written by every
 * module author — i.e. it could be written differently, or forgotten, per module (CLAUDE.md §2.8).
 */
export function payloadSchemaFor<DB>(
  declaration: OperationDeclaration<DB>,
  schemaVersion: number,
): InputParser<unknown> | undefined {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) return undefined;
  if (schemaVersion === declaration.schemaVersion) return declaration.payload;
  if (schemaVersion > declaration.schemaVersion) return undefined;
  return declaration.payloadByVersion?.[schemaVersion];
}

/** A command, as DECLARED in a manifest (04 §5). `name` is derived from the key — see `defineModule`. */
export interface CommandDeclaration<TInput, TResult> {
  readonly permission: string;
  readonly input: InputParser<TInput>;
  readonly handler: (
    input: TInput,
    ctx: CommandContext,
  ) => CommandHandlerResult<TResult> | Promise<CommandHandlerResult<TResult>>;
}

/** A query, as DECLARED in a manifest (04 §6). `name` is derived from the key. */
export interface QueryDeclaration<TInput, TRow, DB> {
  readonly permission: string;
  readonly input: InputParser<TInput>;
  readonly handler: (
    input: TInput,
    qctx: QueryContext<DB>,
  ) => QueryPage<TRow> | Promise<QueryPage<TRow>>;
}

/**
 * The type-erased views used to hold heterogeneous commands/queries in one record.
 *
 * `(...args: never[])` is the existing idiom in this package (see `QueryHandle` in runtime/ctx.ts):
 * `never[]` is the bottom of parameter contravariance, so any handler is assignable, while
 * `defineModule`'s generic keeps the CONCRETE type at every call site. Without it the record would
 * need `any`.
 */
export interface AnyCommandDeclaration {
  readonly permission: string;
  readonly input: InputParser<unknown>;
  readonly handler: (...args: never[]) => unknown;
}

/** @see AnyCommandDeclaration */
export interface AnyQueryDeclaration {
  readonly permission: string;
  readonly input: InputParser<unknown>;
  readonly handler: (...args: never[]) => unknown;
}

/**
 * One projection migration (04 §4.4: "ordered, both engines — DDL source of truth stays
 * 10-db-schema").
 *
 * NOTE ON OWNERSHIP: this declares the DDL a module needs; it is NOT a migration RUNNER. Migration
 * bookkeeping (which ran, when, resumability) belongs to `@bolusi/db-client` / `@bolusi/db-server`
 * (10-db §9), and re-implementing it here would be a second migration system (CLAUDE.md §2.8).
 * `applyModuleMigrations` (module/registry.ts) runs them in order for a fresh database — which is
 * what the test harnesses and the applier conformance suite need, and nothing more.
 */
export interface ModuleMigration<DB> {
  /** Stable, unique-within-module name. Ordering comes from array position, not from this. */
  readonly name: string;
  up(db: ProjectionDb<DB>): Promise<void>;
}

/** The `projections` block (04 §4.4). */
export interface ModuleProjections<DB> {
  readonly tables: Readonly<Record<string, ProjectionTableManifest>>;
  readonly migrations?: readonly ModuleMigration<DB>[];
}

/** A module manifest as authored (04 §1). */
export interface ModuleManifest<DB> {
  /** Lowercase, unique; prefixes op types AND permissions (04 §1, 02 §2). */
  readonly id: string;
  readonly operations: Readonly<Record<string, OperationDeclaration<DB>>>;
  readonly projections: ModuleProjections<DB>;
  readonly commands?: Readonly<Record<string, AnyCommandDeclaration>>;
  readonly queries?: Readonly<Record<string, AnyQueryDeclaration>>;
  /** Registry entries per 02 §3.1, keyed by permission id (02 §3.2). */
  readonly permissions?: Readonly<Record<string, PermissionDeclaration>>;
}

/**
 * The defined module: the manifest, with `name` attached to each command/query from its key.
 *
 * WHY THE TYPE IS THIS SHAPE. It maps over the CALLER's manifest type, so
 * `module.commands.createItem.handler` keeps its exact input/result types at every call site —
 * a `Record<string, AnyCommandDeclaration>` return would erase them and make the whole typed-seam
 * argument for `ctx.query`/`execute` moot.
 */
export type ModuleDefinition<DB, M extends ModuleManifest<DB>> = Omit<M, 'commands' | 'queries'> & {
  readonly commands: {
    readonly [K in keyof M['commands']]: M['commands'][K] & { readonly name: K };
  };
  readonly queries: { readonly [K in keyof M['queries']]: M['queries'][K] & { readonly name: K } };
};

/** Module id: lowercase, unique (04 §1). The same grammar the op-type/permission prefixes use. */
const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Validate a manifest and return it as a module definition (04 §1).
 *
 * ON "RETURNED UNCHANGED". Every declared value the caller wrote — every applier, handler, payload
 * schema, table manifest, permission entry — is carried through by REFERENCE, and the input object
 * is never mutated. The one addition is the `name` on each command/query, derived from its manifest
 * key: 04 §5's shape declares commands as `commands: { createNote: {...} }` with the name as the
 * key, while the denial op's `target` (02 §7) must be able to say WHAT was attempted. Deriving it
 * beats declaring it twice and letting the two drift. So `defineModule(m).operations === m.operations`
 * holds, and `defineModule(m).commands.createNote.handler === m.commands.createNote.handler` holds;
 * `defineModule(m).commands !== m.commands`, because that record is where the names are attached.
 *
 * @throws {ModuleDefinitionError} naming the offending key — at import time.
 */
export function defineModule<DB, const M extends ModuleManifest<DB>>(
  manifest: M,
): ModuleDefinition<DB, M> {
  const moduleId = manifest.id;
  if (typeof moduleId !== 'string' || !MODULE_ID_PATTERN.test(moduleId)) {
    throw new ModuleDefinitionError(
      `module id ${JSON.stringify(moduleId)} is not lowercase alphanumeric (04 §1: ${String(MODULE_ID_PATTERN)}) — it prefixes every op type and permission the module declares`,
    );
  }

  validateOperations(manifest);
  validateProjections(manifest);
  validatePermissions(manifest);

  // The cast is unavoidable and narrow: the mapped return type attaches each key as a literal
  // `name`, which no runtime construction can express to the checker. `withNames` IS that mapping,
  // and the suite asserts the runtime result matches (names present, everything else by reference).
  return {
    ...manifest,
    commands: withNames(manifest.commands ?? {}),
    queries: withNames(manifest.queries ?? {}),
  } as unknown as ModuleDefinition<DB, M>;
}

/** Attach each key as `name`, preserving every other member by reference. */
function withNames<T extends object>(record: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [name, declaration] of Object.entries(record)) {
    out[name] = { ...declaration, name };
  }
  return out;
}

function validateOperations<DB>(manifest: ModuleManifest<DB>): void {
  const operations = manifest.operations;
  if (typeof operations !== 'object' || operations === null) {
    throw new ModuleDefinitionError(
      `module ${manifest.id} declares no operations block (04 §3) — a module that emits no ops has nothing to project`,
    );
  }

  for (const [type, declaration] of Object.entries(operations)) {
    const rejection = checkOpType(type, manifest.id);
    if (rejection !== null) {
      throw new ModuleDefinitionError(`module ${manifest.id}: ${rejection}`);
    }

    // `schemaVersion` (04 §3). Integer ≥ 1: it indexes an append-only history, so 0/negative/
    // fractional versions are not "unusual", they are unrepresentable in the log's contract.
    const { schemaVersion } = declaration;
    if (
      typeof schemaVersion !== 'number' ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 1
    ) {
      throw new ModuleDefinitionError(
        `op type ${type} declares schemaVersion ${JSON.stringify(schemaVersion)} — must be an integer >= 1 (04 §3; the runtime resolves an op's schemaVersion from this declaration)`,
      );
    }

    // `reversal` (04 §3, MANDATORY).
    const { reversal } = declaration;
    if (typeof reversal !== 'string' || reversal.trim().length === 0) {
      throw new ModuleDefinitionError(
        `op type ${type} declares no reversal — it is MANDATORY (04 §3, 05 §7): state how this op is undone. It is documentation in v0; an executable buildReversal slots in for V2.`,
      );
    }

    if (typeof declaration.apply !== 'function') {
      throw new ModuleDefinitionError(
        `op type ${type} declares no apply function (04 §3/§4.1) — every op type this module emits folds into its projection`,
      );
    }

    // `.strict()` payload (04 §3). Probed behaviourally — see strict-schema.ts.
    const payload = declaration.payload;
    if (typeof payload !== 'object' || payload === null || typeof payload.parse !== 'function') {
      throw new ModuleDefinitionError(
        `op type ${type} declares no payload schema with a parse() (04 §3)`,
      );
    }
    if (!isStrictSchema(payload)) {
      throw new ModuleDefinitionError(
        `op type ${type}'s payload schema does not reject unknown keys — 04 §3 requires .strict() (use z.strictObject({...}) or z.object({...}).strict()). A schema that strips or passes through unknown keys lets a client believe it recorded a field the append-only log does not contain.`,
      );
    }

    validateRetainedPayloads(type, declaration);

    // `conflict` (01 §8.1) — OPTIONAL, but a malformed one is worse than an absent one: the
    // server's Rule-1 detection reads `key` to decide what collides. An empty key would make
    // every op on an entity collide with every other; an unknown severity would land a row the
    // `conflicts` CHECK constraint rejects, aborting a push transaction (10-db §8).
    const { conflict } = declaration;
    if (conflict !== undefined) {
      if (typeof conflict.key !== 'string' || conflict.key.trim().length === 0) {
        throw new ModuleDefinitionError(
          `op type ${type} declares a conflict with key ${JSON.stringify(conflict.key)} — it must be a non-empty string (01 §8.1). Two ops conflict only when they share (entityId, conflict.key); an empty key collides everything on the entity with everything else.`,
        );
      }
      if (conflict.severity !== 'minor' && conflict.severity !== 'significant') {
        throw new ModuleDefinitionError(
          `op type ${type} declares conflict severity ${JSON.stringify(conflict.severity)} — must be 'minor' or 'significant' (01 §8.3). The value lands in conflicts.severity, whose CHECK constraint would abort the push transaction that detected it.`,
        );
      }
    }

    // `scope` (01 §6; 05 §2.1) — OPTIONAL, defaulting to 'store'. A typo'd value must not silently
    // degrade to the default: 'tenant' vs 'store' decides whether an op reaches every device or
    // one store's devices, and the wrong answer is a permanent, signed fact in an append-only log.
    const { scope } = declaration;
    if (scope !== undefined && scope !== 'store' && scope !== 'tenant') {
      throw new ModuleDefinitionError(
        `op type ${type} declares scope ${JSON.stringify(scope)} — must be 'store' or 'tenant' (01 §6; 05 §2.1: storeId null = tenant-scoped). Omit it for the default 'store' (the device's store, 02 §5.2).`,
      );
    }
  }
}

/**
 * `payloadByVersion` (04 §3) — retention is COMPLETE or the boot fails.
 *
 * This is the "closed by construction" half of task 127's fix, and it is the half that matters:
 * the server's `resolve(type, version)` fails closed on a missing retained schema, so a forgotten
 * entry would not be a hole — it would be a type whose old, perfectly legitimate ops are suddenly
 * `SCHEMA_INVALID` in production, permanently, on an append-only log. Discovering that from a
 * rejected op is discovering it far too late, and "remember to add the schema when you bump the
 * version" is exactly the kind of instruction CLAUDE.md §2.11 says has already failed once. So the
 * completeness is CHECKED, at import time, against the version the declaration itself states.
 *
 * A key at or above `schemaVersion` is refused rather than ignored: `payloadByVersion[current]`
 * would be a second schema for the current version, free to drift from `payload`, with nothing
 * saying which one wins — and a key ABOVE current names a version no applier folds (05 §7).
 */
function validateRetainedPayloads<DB>(type: string, declaration: OperationDeclaration<DB>): void {
  const { schemaVersion, payloadByVersion } = declaration;
  const retained = payloadByVersion ?? {};

  for (const [rawVersion, schema] of Object.entries(retained)) {
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1 || version >= schemaVersion) {
      throw new ModuleDefinitionError(
        `op type ${type} retains a payload schema for version ${JSON.stringify(rawVersion)}, which is not a superseded version — payloadByVersion keys must be integers in 1..${schemaVersion - 1} (04 §3). The CURRENT version's schema is \`payload\`; a duplicate entry for it could drift from the one the runtime uses, and a version above current names a shape no applier folds (05 §7).`,
      );
    }
    if (typeof schema !== 'object' || schema === null || typeof schema.parse !== 'function') {
      throw new ModuleDefinitionError(
        `op type ${type} declares payloadByVersion[${version}] with no parse() (04 §3)`,
      );
    }
    if (!isStrictSchema(schema)) {
      throw new ModuleDefinitionError(
        `op type ${type}'s payloadByVersion[${version}] schema does not reject unknown keys — 04 §3's .strict() rule applies to every retained version, not just the current one. A loose retained schema makes "claim an old schemaVersion" a blanket bypass of the unknown-key rule for this type.`,
      );
    }
  }

  // COMPLETENESS. The applier must fold every version in `1..schemaVersion` (05 §7), so every one
  // of them is a version the server can be asked to accept, so every one of them needs a schema.
  const missing: number[] = [];
  for (let version = 1; version < schemaVersion; version += 1) {
    if (retained[version] === undefined) missing.push(version);
  }
  if (missing.length > 0) {
    throw new ModuleDefinitionError(
      `op type ${type} declares schemaVersion ${schemaVersion} but retains no payload schema for version${missing.length > 1 ? 's' : ''} ${missing.join(', ')} — 04 §3 requires payloadByVersion to cover every superseded version. Old ops never disappear (05 §7): the applier folds ${schemaVersion === 2 ? 'v1' : `v1..v${schemaVersion - 1}`} forever, so the server will be asked to accept ${missing.length > 1 ? 'those versions' : `v${missing[0]}`} and has nothing to validate the payload against. Retaining the schema the version was emitted with is the only answer that neither rejects legitimate old clients nor accepts an unvalidated payload into the append-only log (task 127).`,
    );
  }
}

function validateProjections<DB>(manifest: ModuleManifest<DB>): void {
  const projections = manifest.projections;
  if (typeof projections !== 'object' || projections === null) {
    throw new ModuleDefinitionError(
      `module ${manifest.id} declares no projections block (04 §4.4)`,
    );
  }
  const tables = projections.tables;
  if (typeof tables !== 'object' || tables === null) {
    throw new ModuleDefinitionError(
      `module ${manifest.id} declares no projections.tables (04 §4.4)`,
    );
  }

  for (const [table, declaration] of Object.entries(tables)) {
    const columns = Object.keys(declaration.columns ?? {});
    if (columns.length === 0) {
      throw new ModuleDefinitionError(
        `projection table ${manifest.id}.${table} declares no columns (04 §4.4) — the convergence oracle digests manifest-declared columns, so an undeclared column is invisible to every convergence assertion (testing-guide §3.4)`,
      );
    }
    // `entityIdColumn` is what the §4.2 re-fold DELETES BY. If it names a column that does not
    // exist, the delete silently matches nothing and the re-fold duplicates rows instead of
    // replacing them — a convergence bug that looks like an applier bug.
    if (!columns.includes(declaration.entityIdColumn)) {
      throw new ModuleDefinitionError(
        `projection table ${manifest.id}.${table} declares entityIdColumn ${JSON.stringify(declaration.entityIdColumn)}, which is not among its columns (04 §4.4) — the §4.2 re-fold deletes an entity's rows by this column`,
      );
    }
    for (const key of declaration.primaryKey ?? []) {
      if (!columns.includes(key)) {
        throw new ModuleDefinitionError(
          `projection table ${manifest.id}.${table} declares primaryKey column ${JSON.stringify(key)}, which is not among its columns (04 §4.4)`,
        );
      }
    }
    if (
      typeof declaration.projectionVersion !== 'number' ||
      !Number.isInteger(declaration.projectionVersion) ||
      declaration.projectionVersion < 1
    ) {
      throw new ModuleDefinitionError(
        `projection table ${manifest.id}.${table} declares projectionVersion ${JSON.stringify(declaration.projectionVersion)} — must be an integer >= 1 (04 §4.4: bumping it forces a rebuild on upgrade)`,
      );
    }
  }

  const seenMigrations = new Set<string>();
  for (const migration of projections.migrations ?? []) {
    if (typeof migration.name !== 'string' || migration.name.length === 0) {
      throw new ModuleDefinitionError(
        `module ${manifest.id} declares an unnamed projection migration (04 §4.4)`,
      );
    }
    if (seenMigrations.has(migration.name)) {
      throw new ModuleDefinitionError(
        `module ${manifest.id} declares duplicate projection migration ${JSON.stringify(migration.name)} (04 §4.4: migrations are ordered and named)`,
      );
    }
    seenMigrations.add(migration.name);
    if (typeof migration.up !== 'function') {
      throw new ModuleDefinitionError(
        `projection migration ${manifest.id}.${migration.name} declares no up() (04 §4.4)`,
      );
    }
  }
}

/**
 * Own-prefix permission check (02 §2/§3.2 rule 4).
 *
 * Assembly checks this too, across all modules (`assemblePermissionRegistry`). It is ALSO checked
 * here because `defineModule` is the point where the author is looking: a manifest that can only
 * fail once it is composed with the rest of the app reports the defect far from its cause. The two
 * are independent by design — 02 §3.2's rules are assembly's contract, and this is the module's.
 */
function validatePermissions<DB>(manifest: ModuleManifest<DB>): void {
  for (const id of Object.keys(manifest.permissions ?? {})) {
    const separator = id.indexOf('.');
    const prefix = separator === -1 ? '' : id.slice(0, separator);
    if (prefix !== manifest.id) {
      throw new ModuleDefinitionError(
        `module ${manifest.id} declares permission ${JSON.stringify(id)}, whose prefix is ${JSON.stringify(prefix)} — a manifest may declare permissions only under its own id (02 §2, §3.2 rule 4)`,
      );
    }
  }

  // A command/query with no permission is not "public" — it is unenforceable. 02 §4 makes the
  // runtime check THE control, and the check reads `permission`; an absent one would make the
  // control a no-op for that surface. Assembly rule 3 then resolves the id against the registry.
  for (const [kind, record] of [
    ['command', manifest.commands ?? {}],
    ['query', manifest.queries ?? {}],
  ] as const) {
    for (const [name, declaration] of Object.entries(record)) {
      if (typeof declaration.permission !== 'string' || declaration.permission.length === 0) {
        throw new ModuleDefinitionError(
          `${kind} ${manifest.id}.${name} declares no permission (04 §5/§6) — every command and query is permission-checked at the single enforcement point (02 §4); there is no unchecked surface`,
        );
      }
      if (typeof declaration.handler !== 'function') {
        throw new ModuleDefinitionError(`${kind} ${manifest.id}.${name} declares no handler`);
      }
      const input: unknown = declaration.input;
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof (input as InputParser<unknown>).parse !== 'function'
      ) {
        throw new ModuleDefinitionError(
          `${kind} ${manifest.id}.${name} declares no input schema with a parse() (04 §5.1 step 1/§6)`,
        );
      }
    }
  }
}
