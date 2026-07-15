// The module-contract fixture module (04-module-contract §1; 02-permissions §9.3).
//
// 02 §9.3 asks for exactly this: "The shared module-contract test suite includes a fixture module
// with one gated field to keep the mechanism itself under test." It is the smallest thing that
// exercises every seam of the contract end to end — register → command → op → projection → query —
// with one gated column proving 02 §9's absence rule.
//
// It is NOT the `notes` reference module (04 §8, task 25). `notes` proves the contract is usable;
// this proves the contract is ENFORCED, and it deliberately stays trivial so a failure here points
// at the runtime rather than at the module.
//
// ── WHY THIS EXPORTS A MANIFEST AND NOT A DEFINED MODULE ──────────────────────────────────────
//
// It ends at `fixtureModuleManifest` — the INPUT to `defineModule` — and every consumer calls
// `defineModule(fixtureModuleManifest)` itself. That is load-bearing, not stylistic:
//
//   `@bolusi/core` resolves to `dist/`, while core's own tests import `src/`. If this file called
//   `defineModule` at import time it would call DIST's, and a core test asserting on `src`'s
//   `defineModule` would be reading a manifest validated by a different copy of the code — the
//   stale-dist trap (T-14c). Worse, errors would cross the boundary: `ModuleDefinitionError` and
//   `DomainError` from dist are DIFFERENT CLASSES from src's, so `instanceof` silently returns
//   false and a test asserting "this throws DomainError" fails for reasons that look like a logic
//   bug.
//
// So this file imports from `@bolusi/core` with `import type` ONLY. Types are erased, so nothing
// here carries a runtime edge to either copy, and the caller's `defineModule` — whichever artifact
// it came from — is the one that validates. The same property lets task 25 and the harness reuse it
// without inheriting a build-order constraint.
import type { Kysely } from 'kysely';

import type {
  CommandContext,
  CommandHandlerResult,
  ModuleManifest,
  ProjectionApplier,
  ProjectionTableManifest,
  QueryContext,
  QueryPage,
} from '@bolusi/core';

// ── the projection table ───────────────────────────────────────────────────────────────────────

/**
 * The fixture's projection row.
 *
 * Property names are camelCase and the physical columns are snake_case, mapped by Kysely's
 * `CamelCasePlugin` — the same shape `ClientDatabase` and every real applier use (10-db §9).
 */
export interface FixtureItemsTable {
  id: string;
  tenantId: string;
  storeId: string;
  label: string;
  /**
   * THE GATED COLUMN (02 §9). Readable only by a caller holding `fixture.read_secret`; for anyone
   * else the query omits the key entirely — absent, never `null`, never `"***"` (§9.2).
   *
   * It is `not null` in the DDL on purpose: the gate must be the QUERY's doing. If the column were
   * nullable, a test asserting "the unauthorized caller does not see a secret" could pass because
   * the row simply had no secret — the fixture would be broken and the test green (T-14b). Every
   * row always has a real secret, so absence in a result can only mean the gate acted.
   */
  secretNote: string;
  createdBy: string;
  createdAt: number;
}

/** The DB shape the fixture's appliers and queries are typed against. */
export interface FixtureDatabase {
  fixtureItems: FixtureItemsTable;
}

/** Physical table name (what the oracle and the migrations use). */
export const FIXTURE_TABLE = 'fixture_items';

/** 04 §4.4 table manifest — columns in DDL order (the oracle digests them in this order, §3.4). */
export const fixtureItemsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    label: 'text',
    secret_note: 'text',
    created_by: 'text',
    created_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: 'fixture_item',
  entityIdColumn: 'id',
  projectionVersion: 1,
};

// ── the applier ────────────────────────────────────────────────────────────────────────────────

/** `fixture.item_created` payload (04 §3). */
export interface ItemCreatedPayload {
  readonly label: string;
  readonly secretNote: string;
}

/**
 * The one applier (04 §4.1): deterministic, entity-scoped, dialect-neutral.
 *
 * Dialect-neutral is the whole point of the T-8 conformance suite: no raw SQL, no `ON CONFLICT`, no
 * dialect-specific function — just a typed insert Kysely compiles for both engines. This runs
 * unchanged against SQLite and Postgres and must produce byte-identical oracle digests.
 */
const itemCreatedApplier: ProjectionApplier<FixtureDatabase> = async (db, op) => {
  const payload = op.payload as unknown as ItemCreatedPayload;
  await db
    .insertInto('fixtureItems')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId ?? '',
      label: payload.label,
      secretNote: payload.secretNote,
      createdBy: op.userId,
      createdAt: op.timestamp,
    })
    .execute();
};

// ── strict parsers (zod's behaviour, without zod) ──────────────────────────────────────────────

/**
 * A parse failure in Zod's OWN shape — deliberately (T-13, interrogate the oracle).
 *
 * `@bolusi/test-support` may not import zod (08 §3.3), so the fixture's schemas are hand-written.
 * That makes this shape a claim ABOUT zod, and `defineModule`'s `.strict()` probe reads exactly
 * these fields — so if this diverged from zod, the probe would be verified against fiction and pass
 * for a schema real zod would fail. Two things keep it honest: this mirrors zod's real
 * `unrecognized_keys` issue (`{ code, keys, path: [] }` — the key names ride `keys`, NOT `path`),
 * and `packages/core/test/module/strict-schema.test.ts` drives the probe against REAL zod so the
 * probe is proven against the article, not the imitation.
 */
export class FixtureParseError extends Error {
  readonly issues: readonly FixtureParseIssue[];
  constructor(issues: readonly FixtureParseIssue[]) {
    super('fixture strict parse failed');
    this.issues = issues;
  }
}

export interface FixtureParseIssue {
  readonly path: readonly string[];
  readonly code: string;
  readonly message: string;
  /** Present on `unrecognized_keys` only — where Zod puts the offending key names. */
  readonly keys?: readonly string[];
}

/** Build a `z.strictObject(...)`-equivalent parser: unknown keys rejected, fields type-checked. */
function strictParser<T>(
  fields: Readonly<Record<string, (value: unknown) => boolean>>,
  optional: ReadonlySet<string> = new Set(),
): { parse(raw: unknown): T } {
  return {
    parse(raw: unknown): T {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new FixtureParseError([
          { path: [], code: 'invalid_type', message: 'expected object' },
        ]);
      }
      const value = raw as Record<string, unknown>;
      const issues: FixtureParseIssue[] = [];

      // Unknown keys FIRST and always reported, exactly as zod does — zod does not short-circuit
      // on missing required fields, and the strictness probe depends on that (strict-schema.ts).
      const unknown = Object.keys(value).filter((key) => !(key in fields));
      if (unknown.length > 0) {
        issues.push({
          path: [],
          code: 'unrecognized_keys',
          message: `unrecognized key(s): ${unknown.join(', ')}`,
          keys: unknown,
        });
      }
      for (const [key, check] of Object.entries(fields)) {
        if (!(key in value) || value[key] === undefined) {
          if (!optional.has(key)) {
            issues.push({ path: [key], code: 'invalid_type', message: `${key} is required` });
          }
          continue;
        }
        if (!check(value[key])) {
          issues.push({ path: [key], code: 'invalid_type', message: `${key} has the wrong type` });
        }
      }
      if (issues.length > 0) throw new FixtureParseError(issues);
      return value as T;
    },
  };
}

const isNonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isString = (v: unknown): boolean => typeof v === 'string';

/** The `fixture.item_created` payload schema — `.strict()` per 04 §3. */
export const itemCreatedPayload = strictParser<ItemCreatedPayload>({
  label: isNonEmptyString,
  secretNote: isString,
});

// ── the command ────────────────────────────────────────────────────────────────────────────────

export interface CreateItemInput {
  readonly label: string;
  readonly secretNote: string;
}

const createItemInput = strictParser<CreateItemInput>({
  label: isNonEmptyString,
  secretNote: isString,
});

// ── the query ──────────────────────────────────────────────────────────────────────────────────

/** `listItems` sort options (04 §6). The id tiebreaker is implicit — see `cursor.ts`. */
export type FixtureSort = 'createdAt.asc' | 'createdAt.desc';

export interface ListItemsInput {
  readonly sort: FixtureSort;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `listItems` input schema — `z.object({ sort: …default('createdAt.desc'), cursor: z.string()
 * .optional(), limit: z.number().int().max(100).default(50) })` in behaviour (04 §6).
 *
 * The `max(100)` is the SCHEMA's job, not the handler's (04 §6 declares it on the schema), so an
 * over-large limit is `VALIDATION_FAILED` at step 1 and the handler never runs — a caller cannot
 * ask the database for 10,000 rows and have the handler quietly clamp it, which would turn a
 * rejected request into a slow one.
 */
export const listItemsInput = {
  parse(raw: unknown): ListItemsInput {
    if (raw === undefined || raw === null) return { sort: 'createdAt.desc', limit: 50 };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new FixtureParseError([{ path: [], code: 'invalid_type', message: 'expected object' }]);
    }
    const value = raw as Record<string, unknown>;
    const issues: FixtureParseIssue[] = [];

    const unknown = Object.keys(value).filter(
      (key) => key !== 'sort' && key !== 'cursor' && key !== 'limit',
    );
    if (unknown.length > 0) {
      issues.push({
        path: [],
        code: 'unrecognized_keys',
        message: `unrecognized key(s): ${unknown.join(', ')}`,
        keys: unknown,
      });
    }

    const sort = value.sort ?? 'createdAt.desc';
    if (sort !== 'createdAt.asc' && sort !== 'createdAt.desc') {
      issues.push({ path: ['sort'], code: 'invalid_enum_value', message: 'unknown sort' });
    }
    if (value.cursor !== undefined && typeof value.cursor !== 'string') {
      issues.push({ path: ['cursor'], code: 'invalid_type', message: 'cursor must be a string' });
    }
    const limit = value.limit ?? 50;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      issues.push({
        path: ['limit'],
        code: 'invalid_type',
        message: 'limit must be an integer >= 1',
      });
    } else if (limit > 100) {
      issues.push({ path: ['limit'], code: 'too_big', message: 'limit must be <= 100' });
    }

    if (issues.length > 0) throw new FixtureParseError(issues);
    return {
      sort: sort as FixtureSort,
      ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
      limit: limit as number,
    };
  },
};

/**
 * A row of `listItems`.
 *
 * `secretNote` is OPTIONAL IN THE TYPE, which is the type-level statement of 02 §9.2: the field is
 * absent for a caller without `fixture.read_secret`. `string | null` would have been the wrong type
 * — it would say "always present, sometimes empty", which is precisely the masked/nulled shape §9.2
 * forbids, and would let a caller's `'secretNote' in row` check pass while the value was withheld.
 */
export interface FixtureItemRow {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly secretNote?: string;
}

/** The permission gating `secretNote` (02 §9.3: every gated field maps to a registry permission). */
export const FIXTURE_SECRET_PERMISSION = 'fixture.read_secret';

// ── the manifest ───────────────────────────────────────────────────────────────────────────────

/**
 * The fixture manifest (04 §1). Pass it to `defineModule` — see the file header for why this file
 * does not.
 *
 * `listItemsHandler` is injected by `makeFixtureModuleManifest` rather than written inline, because
 * the handler needs `encodeCursor`/`decodeCursor` from `@bolusi/core` — VALUES, which this file
 * must not import (header). The consumer passes the codec from whichever core artifact it is
 * testing, and the gating logic itself lives here, once.
 */
export interface FixtureCursorCodec {
  encodeCursor(position: { sort: string; values: readonly (string | number)[] }): string;
  decodeCursor(
    cursor: string,
    expectedSort: string,
  ): { sort: string; values: readonly (string | number)[] };
}

/**
 * Build the fixture manifest against a given cursor codec.
 *
 * @param codec `{ encodeCursor, decodeCursor }` from the `@bolusi/core` artifact under test.
 */
export function makeFixtureModuleManifest(
  codec: FixtureCursorCodec,
): ModuleManifest<FixtureDatabase> {
  return {
    id: 'fixture',

    operations: {
      'fixture.item_created': {
        schemaVersion: 1,
        payload: itemCreatedPayload,
        reversal:
          'Reversed by fixture.item_archived on the same entityId (v1 — the fixture models the declaration, not the behaviour).',
        apply: itemCreatedApplier,
      },
    },

    projections: {
      tables: { [FIXTURE_TABLE]: fixtureItemsTable },
      migrations: [
        {
          name: '0001_fixture_items',
          async up(db: Kysely<FixtureDatabase>): Promise<void> {
            // Dialect-neutral DDL: `text`/`integer` are the two logical types 04 §4.4 allows here,
            // and Kysely compiles both for SQLite and Postgres. `notNull` on `secret_note` is what
            // makes the gating test's fixture honest (see FixtureItemsTable.secretNote).
            await db.schema
              .createTable(FIXTURE_TABLE)
              .addColumn('id', 'text', (c) => c.primaryKey())
              .addColumn('tenant_id', 'text', (c) => c.notNull())
              .addColumn('store_id', 'text', (c) => c.notNull())
              .addColumn('label', 'text', (c) => c.notNull())
              .addColumn('secret_note', 'text', (c) => c.notNull())
              .addColumn('created_by', 'text', (c) => c.notNull())
              // `bigint`, not `integer`: an ms-epoch timestamp is ~1.7e12, and Postgres `integer`
              // is 32-bit — it overflows, while SQLite's 64-bit INTEGER accepts it. The applier
              // conformance suite (T-8) caught exactly this on its first run. The MANIFEST still
              // declares the logical type `integer` (04 §4.4's oracle types are text/integer/
              // boolean/blob — a normalization vocabulary, not DDL), which is the same split
              // db-server's notes DDL uses: `created_at bigint` under a logical `integer`.
              .addColumn('created_at', 'bigint', (c) => c.notNull())
              .execute();
          },
        },
      ],
    },

    permissions: {
      'fixture.create': {
        scope: 'store',
        isDangerous: false,
        description: 'Can create a fixture item in the store.',
      },
      'fixture.read': {
        scope: 'store',
        isDangerous: false,
        description: 'Can read the store’s fixture items.',
      },
      'fixture.read_secret': {
        scope: 'store',
        isDangerous: false,
        description: 'Can see the confidential note attached to a fixture item.',
      },
    },

    commands: {
      createItem: {
        permission: 'fixture.create',
        input: createItemInput,
        handler: (
          input: CreateItemInput,
          ctx: CommandContext,
        ): CommandHandlerResult<{ id: string }> => {
          const id = ctx.newId();
          return {
            ops: [
              ctx.op({
                type: 'fixture.item_created',
                entityType: 'fixture_item',
                entityId: id,
                payload: { label: input.label, secretNote: input.secretNote },
              }),
            ],
            result: { id },
          };
        },
      },
    },

    queries: {
      listItems: {
        permission: 'fixture.read',
        input: listItemsInput,
        handler: async (
          input: ListItemsInput,
          qctx: QueryContext<FixtureDatabase>,
        ): Promise<QueryPage<FixtureItemRow>> => {
          const descending = input.sort === 'createdAt.desc';

          // ── THE GATE (02 §9.1) ──────────────────────────────────────────────────────────────
          //
          // Decided HERE, in the handler, before the row is shaped — and it decides what is
          // SELECTED, not what is deleted afterwards. 02 §9 is "never sent to the client", not
          // "sent and then hidden": for an unauthorized caller `secret_note` is never named in the
          // SQL, so it is not in the result set, not in memory, and not in any log of the query.
          // Selecting it and deleting the key would satisfy the absence assertion and still be the
          // wrong thing (and on the future server-side runtime, §9.5, it would be wrong at the
          // wire).
          const mayReadSecret = qctx.hasPermission(FIXTURE_SECRET_PERMISSION);

          let query = qctx.db
            .selectFrom('fixtureItems')
            .select(['id', 'label', 'createdAt'])
            // Scope comes from `qctx` — which the runtime minted — and NEVER from the input or the
            // cursor. This is what makes an unsigned cursor safe (core/src/query/cursor.ts).
            .where('tenantId', '=', qctx.tenantId)
            .where('storeId', '=', qctx.storeId ?? '')
            .orderBy('createdAt', descending ? 'desc' : 'asc')
            // The id tiebreaker makes the order TOTAL. Without it two rows sharing a timestamp
            // have no defined relative order, and a page boundary between them drops or repeats
            // one — the exact bug cursor pagination exists to prevent.
            .orderBy('id', descending ? 'desc' : 'asc');

          if (mayReadSecret) {
            query = query.select(['secretNote']);
          }

          if (input.cursor !== undefined) {
            const position = codec.decodeCursor(input.cursor, input.sort);
            const [lastCreatedAt, lastId] = position.values as [number, string];
            // Keyset seek on the SAME total order as the ORDER BY. Kysely compiles this row-value
            // comparison for both engines.
            query = query.where((eb) =>
              eb.or([
                eb('createdAt', descending ? '<' : '>', lastCreatedAt),
                eb.and([
                  eb('createdAt', '=', lastCreatedAt),
                  eb('id', descending ? '<' : '>', lastId),
                ]),
              ]),
            );
          }

          // Fetch one MORE than asked: the extra row is how "is there a next page?" is answered
          // without a second COUNT query, and it is what makes the last page's `nextCursor` null
          // rather than a cursor that yields an empty page (04 §6).
          const found = await query.limit(input.limit + 1).execute();
          const hasMore = found.length > input.limit;
          const page = hasMore ? found.slice(0, input.limit) : found;

          const rows: FixtureItemRow[] = page.map((row) => ({
            id: row.id,
            label: row.label,
            createdAt: row.createdAt,
            // ABSENT, not null (02 §9.2). The conditional spread is the mechanism: for an
            // unauthorized caller the key never exists on the object, so `'secretNote' in row` is
            // false — which is what the adversarial test asserts.
            ...(mayReadSecret && 'secretNote' in row
              ? { secretNote: (row as { secretNote: string }).secretNote }
              : {}),
          }));

          const last = page[page.length - 1];
          const nextCursor =
            hasMore && last !== undefined
              ? codec.encodeCursor({ sort: input.sort, values: [last.createdAt, last.id] })
              : null;

          return { rows, nextCursor };
        },
      },
    },
  };
}
