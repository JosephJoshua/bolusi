// Client migration tests against a REAL SQLite engine (better-sqlite3 in-memory).
//
// The DDL is asserted against the 10-db §9 spec list rather than against itself: the
// point is to catch a table or index that drifted away from the spec, which a
// self-referential assertion could never see.
import { beforeEach, describe, expect, test } from 'vitest';

import { CLIENT_MIGRATIONS, runClientMigrations } from '../src/migrations/runner.js';
import type { DbDriver } from '../src/driver.js';
import { openTestDriver } from './better-sqlite3-adapter.js';

// 10-db §9.1–§9.6, transcribed from the spec — all 19 client tables.
const SPEC_TABLES = [
  'auth_permission_denials',
  'auth_sessions',
  'conflicts',
  'device_registry',
  'media_items',
  'meta_kv',
  'migrations',
  'notes',
  'operations',
  'pin_attempt_state',
  'pin_lockout_events',
  'projection_watermarks',
  'quarantined_ops',
  'roles_directory',
  'sync_state',
  'user_pin_verifiers',
  'user_prefs',
  'user_roles_directory',
  'users_directory',
];

// Every index the spec declares (10-db §9.2/§9.4/§9.6, §10 query-pattern table).
const SPEC_INDEXES = [
  'idx_conflicts_surfaced',
  'idx_media_items_queue',
  'idx_notes_created',
  'idx_operations_device_seq',
  'idx_operations_entity_canonical',
  'idx_operations_push_queue',
  'idx_operations_rejected',
];

let driver: DbDriver;

beforeEach(async () => {
  driver = await openTestDriver();
});

async function objectNames(type: 'table' | 'index'): Promise<string[]> {
  // sqlite_autoindex_* rows are SQLite's own artefacts for UNIQUE constraints, not our DDL.
  const result = await driver.execute(
    `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    [type],
  );
  return result.rows.map((row) => String(row['name']));
}

describe('runClientMigrations against a fresh database', () => {
  test('creates exactly the tables 10-db §9 specifies', async () => {
    await runClientMigrations(driver, { now: () => 1_700_000_000_000 });
    expect(await objectNames('table')).toEqual(SPEC_TABLES);
  });

  test('creates exactly the indexes 10-db §9/§10 specify', async () => {
    await runClientMigrations(driver, { now: () => 1_700_000_000_000 });
    expect(await objectNames('index')).toEqual(SPEC_INDEXES);
  });

  test('operations partial indexes carry their WHERE clauses', async () => {
    await runClientMigrations(driver, { now: () => 1_700_000_000_000 });
    const rows = await driver.execute(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?)`,
      [
        'idx_operations_push_queue',
        'idx_operations_rejected',
        'idx_media_items_queue',
        'idx_conflicts_surfaced',
      ],
    );
    const byName = new Map(rows.rows.map((row) => [String(row['name']), String(row['sql'])]));

    // A partial index silently created as a full index would still "exist" but would stop
    // serving the push-queue / surfacing query patterns (10-db §10).
    expect(byName.get('idx_operations_push_queue')).toContain("WHERE sync_status = 'local'");
    expect(byName.get('idx_operations_rejected')).toContain("WHERE sync_status = 'rejected'");
    expect(byName.get('idx_media_items_queue')).toContain("WHERE upload_status <> 'uploaded'");
    expect(byName.get('idx_conflicts_surfaced')).toContain("WHERE status = 'surfaced'");
  });

  test('idx_operations_device_seq is UNIQUE', async () => {
    await runClientMigrations(driver, { now: () => 1_700_000_000_000 });
    const rows = await driver.execute(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_operations_device_seq'`,
    );
    expect(String(rows.rows[0]?.['sql'])).toContain('CREATE UNIQUE INDEX');
  });

  test('seeds the sync_state singleton row id = 1', async () => {
    await runClientMigrations(driver, { now: () => 1_700_000_000_000 });
    const rows = await driver.execute(`SELECT id, pull_cursor, push_halted FROM sync_state`);
    expect(rows.rows).toEqual([{ id: 1, pull_cursor: 0, push_halted: 0 }]);
  });

  test('records the applied version with the injected clock', async () => {
    const result = await runClientMigrations(driver, { now: () => 1_700_000_000_000 });
    expect(result.applied).toEqual([1]);

    const rows = await driver.execute(`SELECT version, name, applied_at FROM migrations`);
    expect(rows.rows).toEqual([
      { version: 1, name: 'initial_schema', applied_at: 1_700_000_000_000 },
    ]);
  });
});

describe('runner is idempotent', () => {
  test('a second run applies nothing and leaves one bookkeeping row', async () => {
    const first = await runClientMigrations(driver, { now: () => 1 });
    const second = await runClientMigrations(driver, { now: () => 2 });

    expect(first.applied).toEqual([1]);
    expect(second.applied).toEqual([]);

    const rows = await driver.execute(`SELECT COUNT(*) AS c FROM migrations`);
    expect(rows.rows).toEqual([{ c: 1 }]);
    // Re-running must not re-seed the singleton either.
    const state = await driver.execute(`SELECT COUNT(*) AS c FROM sync_state`);
    expect(state.rows).toEqual([{ c: 1 }]);
  });
});

describe('transactional apply', () => {
  test('a failing migration leaves NO partial schema', async () => {
    await expect(
      runClientMigrations(driver, {
        now: () => 1,
        migrations: [
          {
            version: 1,
            name: 'broken',
            statements: [
              `CREATE TABLE first_half (id TEXT PRIMARY KEY)`,
              `CREATE TABLE second_half (this is not valid sql`,
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ name: 'DbError' });

    // The rollback must take the already-created table with it — a half-applied schema is
    // worse than none: the next run would skip nothing and fail on CREATE TABLE.
    expect(await objectNames('table')).toEqual([]);
  });

  test('a migration failing midway does not record its version', async () => {
    await runClientMigrations(driver, { now: () => 1 });
    await expect(
      runClientMigrations(driver, {
        now: () => 2,
        migrations: [
          ...CLIENT_MIGRATIONS,
          { version: 2, name: 'broken', statements: [`CREATE TABLE x (bad sql here`] },
        ],
      }),
    ).rejects.toMatchObject({ name: 'DbError' });

    const rows = await driver.execute(`SELECT version FROM migrations ORDER BY version`);
    expect(rows.rows).toEqual([{ version: 1 }]);
  });

  test('applies pending migrations after an already-applied one', async () => {
    await runClientMigrations(driver, { now: () => 1 });
    const result = await runClientMigrations(driver, {
      now: () => 2,
      migrations: [
        ...CLIENT_MIGRATIONS,
        {
          version: 2,
          name: 'adds_table',
          statements: [`CREATE TABLE later (id TEXT PRIMARY KEY)`],
        },
      ],
    });

    expect(result.applied).toEqual([2]);
    expect(await objectNames('table')).toContain('later');
  });
});

// The CHECK constraints are not decoration: they are the last line of defence for enum
// columns the op log and state machines depend on (10-db §9.2/§9.3).
describe('CHECK constraints are live', () => {
  beforeEach(async () => {
    await runClientMigrations(driver, { now: () => 1 });
  });

  const insertOperation = (overrides: Record<string, string | number>) => {
    const row: Record<string, string | number> = {
      id: 'op-1',
      tenant_id: 't',
      user_id: 'u',
      device_id: 'd',
      seq: 1,
      type: 'notes.note_created',
      entity_type: 'note',
      entity_id: 'n',
      schema_version: 1,
      payload: '{}',
      timestamp_ms: 1,
      source: 'ui',
      previous_hash: 'p',
      hash: 'h',
      signature: 's',
      signed_core_jcs: '{}',
      ...overrides,
    };
    const columns = Object.keys(row);
    return driver.execute(
      `INSERT INTO operations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
    );
  };

  test('operations.source outside the enum is rejected', async () => {
    await expect(insertOperation({ source: 'bogus' })).rejects.toMatchObject({
      name: 'DbError',
      code: 'constraint',
    });
    await expect(insertOperation({ source: 'agent' })).resolves.toBeDefined();
  });

  test('operations.seq = 0 is rejected (seq >= 1)', async () => {
    await expect(insertOperation({ seq: 0 })).rejects.toMatchObject({ code: 'constraint' });
  });

  test('operations.schema_version = 0 is rejected (schema_version >= 1)', async () => {
    await expect(insertOperation({ schema_version: 0 })).rejects.toMatchObject({
      code: 'constraint',
    });
  });

  test('operations.sync_status outside the enum is rejected and defaults to local', async () => {
    await expect(insertOperation({ sync_status: 'bogus' })).rejects.toMatchObject({
      code: 'constraint',
    });
    await insertOperation({});
    const rows = await driver.execute(`SELECT sync_status FROM operations WHERE id = 'op-1'`);
    expect(rows.rows).toEqual([{ sync_status: 'local' }]);
  });

  test('a second sync_state row is rejected (id = 1 singleton)', async () => {
    await expect(driver.execute(`INSERT INTO sync_state (id) VALUES (2)`)).rejects.toMatchObject({
      code: 'constraint',
    });
    const rows = await driver.execute(`SELECT COUNT(*) AS c FROM sync_state`);
    expect(rows.rows).toEqual([{ c: 1 }]);
  });

  test('idx_operations_device_seq rejects a duplicate (device_id, seq)', async () => {
    await insertOperation({});
    await expect(insertOperation({ id: 'op-2' })).rejects.toMatchObject({ code: 'constraint' });
  });

  const enumCases: readonly (readonly [string, string, string])[] = [
    [
      'media_items.type',
      `INSERT INTO media_items (id, tenant_id, captured_by_user_id, device_id, type, mime_type, byte_size, sha256, captured_at) VALUES ('m', 't', 'u', 'd', ?, 'image/jpeg', 1, 'x', 1)`,
      'bogus',
    ],
    [
      'users_directory.status',
      `INSERT INTO users_directory (id, name, status) VALUES ('u', 'n', ?)`,
      'bogus',
    ],
    [
      'roles_directory.scope_type',
      `INSERT INTO roles_directory (id, name, scope_type, permission_ids) VALUES ('r', 'n', ?, '[]')`,
      'bogus',
    ],
    [
      'device_registry.kind',
      `INSERT INTO device_registry (id, kind, signing_key_public, status) VALUES ('d', ?, 'k', 'active')`,
      'bogus',
    ],
    [
      'quarantined_ops.reason',
      `INSERT INTO quarantined_ops (id, device_id, server_seq, signed_core_jcs, hash, signature, reason, quarantined_at) VALUES ('q', 'd', 1, '{}', 'h', 's', ?, 1)`,
      'bogus',
    ],
    [
      'conflicts.severity',
      `INSERT INTO conflicts (id, tenant_id, entity_type, entity_id, conflict_key, severity, status, op_a_id, op_b_id, detected_at) VALUES ('c', 't', 'note', 'n', 'k', ?, 'detected', 'a', 'b', 1)`,
      'bogus',
    ],
    [
      'user_pin_verifiers.algo',
      `INSERT INTO user_pin_verifiers (user_id, algo, salt, params, hash, as_of_timestamp, as_of_device_id, as_of_seq) VALUES ('u', ?, 's', '{}', 'h', 1, 'd', 1)`,
      'bcrypt',
    ],
    [
      'pin_lockout_events.kind',
      `INSERT INTO pin_lockout_events (id, tenant_id, user_id, device_id, kind, at) VALUES ('p', 't', 'u', 'd', ?, 1)`,
      'bogus',
    ],
  ];

  for (const [label, sql, badValue] of enumCases) {
    test(`${label} outside the enum is rejected`, async () => {
      await expect(driver.execute(sql, [badValue])).rejects.toMatchObject({ code: 'constraint' });
    });
  }
});
