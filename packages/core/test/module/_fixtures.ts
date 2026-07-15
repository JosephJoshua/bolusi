// Module-suite fixtures.
//
// T-3 (unique values per case): every manifest is built from a SEED, so no two tests assert on the
// same module id, op type, or permission id. Shared constants make tests pass by coincidence and
// fail in bulk — and in this suite specifically, a shared module id would make the "duplicate
// module id" test pass for the wrong reason.
import type {
  InputParser,
  ModuleManifest,
  ProjectionApplier,
  ProjectionTableManifest,
} from '../../src/index.js';

/** The DB shape these fixtures' appliers are typed against. */
export interface FixtureSuiteDatabase {
  widgets: {
    id: string;
    tenantId: string;
    name: string;
  };
}

/**
 * A `.strict()` parser in zod's OBSERVABLE shape (T-13).
 *
 * `defineModule`'s probe reads `error.issues[].code === 'unrecognized_keys'` + `keys`. This mirrors
 * that; `strict-schema.test.ts` proves the probe against REAL zod, so this fixture cannot make the
 * probe look like it works when it does not.
 */
export function strictSchema<T = unknown>(): InputParser<T> {
  return {
    parse(raw: unknown): T {
      if (typeof raw !== 'object' || raw === null) {
        throw Object.assign(new Error('expected object'), {
          issues: [{ path: [], code: 'invalid_type' }],
        });
      }
      const unknown = Object.keys(raw as Record<string, unknown>).filter((k) => k !== 'name');
      if (unknown.length > 0) {
        throw Object.assign(new Error('unrecognized keys'), {
          issues: [{ path: [], code: 'unrecognized_keys', keys: unknown }],
        });
      }
      return raw as T;
    },
  };
}

/** A schema that STRIPS unknown keys — zod's default, and NOT `.strict()` (04 §3). */
export function strippingSchema<T = unknown>(): InputParser<T> {
  return {
    parse(raw: unknown): T {
      const value = { ...(raw as Record<string, unknown>) };
      for (const key of Object.keys(value)) {
        if (key !== 'name') delete value[key];
      }
      return value as T;
    },
  };
}

/** A schema that PASSES unknown keys through — `z.looseObject`, also not `.strict()`. */
export function passthroughSchema<T = unknown>(): InputParser<T> {
  return { parse: (raw: unknown): T => raw as T };
}

const noopApplier: ProjectionApplier<FixtureSuiteDatabase> = () => {
  // Intentionally empty: these fixtures test MANIFEST VALIDATION, which never invokes an applier.
  // The round-trip and conformance suites drive real appliers.
};

export function widgetsTable(): ProjectionTableManifest {
  return {
    columns: { id: 'text', tenant_id: 'text', name: 'text' },
    primaryKey: ['id'],
    entityType: 'widget',
    entityIdColumn: 'id',
    projectionVersion: 1,
  };
}

/** A module id unique to `seed` — `m3`, `m17`, … (04 §1: lowercase alphanumeric). */
export function moduleIdFor(seed: number): string {
  return `m${seed}`;
}

/**
 * A fully valid manifest, unique per seed (T-3). Every rejection test starts from this and breaks
 * exactly ONE thing — so a test that fails proves the thing it broke, not a typo elsewhere.
 */
export function validManifest(seed: number): ModuleManifest<FixtureSuiteDatabase> {
  const id = moduleIdFor(seed);
  return {
    id,
    operations: {
      [`${id}.widget_created`]: {
        schemaVersion: 1,
        payload: strictSchema(),
        reversal: `Reversed by ${id}.widget_archived on the same entityId.`,
        apply: noopApplier,
      },
    },
    projections: { tables: { [`${id}_widgets`]: widgetsTable() } },
    permissions: {
      [`${id}.create`]: {
        scope: 'store',
        isDangerous: false,
        description: `Can create a widget in module ${id}.`,
      },
      [`${id}.read`]: {
        scope: 'store',
        isDangerous: false,
        description: `Can read widgets in module ${id}.`,
      },
    },
    commands: {
      createWidget: {
        permission: `${id}.create`,
        input: strictSchema(),
        handler: () => ({ ops: [] }),
      },
    },
    queries: {
      listWidgets: {
        permission: `${id}.read`,
        input: strictSchema(),
        handler: () => ({ rows: [], nextCursor: null }),
      },
    },
  };
}
