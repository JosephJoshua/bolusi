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
  /** MANDATORY prose: how this op is reversed (04 §3, 05 §7). */
  readonly reversal: string;
  /** The fold step (04 §4.1). */
  readonly apply: ProjectionApplier<DB>;
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
