// `deleteOpSqliteDatabase` — the DB-file leg of the boot-recovery wipe (security-guide §6.6; the
// mobile boot-recovery task). This drives the REAL adapter function; op-sqlite is mocked to remove
// EXACTLY ONE file per `delete()`, mirroring its native behaviour (`opsqlite_remove` is
// `close(db); remove(db_path)` — one unlink, no WAL checkpoint). So the production code — not a
// more-thorough hand-rolled deletion — is what must remove the `-wal`/`-shm` sidecars, and a
// regression that stops removing one REDS this file.
//
// WHY THE MOCK, AND WHAT IT DOES NOT PROVE (D12/D13): op-sqlite is a JSI native module that cannot
// load under Node, and no iOS/Android target exists here (task 85). The mock stands in for op-sqlite's
// per-file unlink; it does NOT prove op-sqlite's real `delete()` removes what the mock removes — that
// is the on-device leg. What it DOES prove is that `deleteOpSqliteDatabase` issues a delete for the
// main file AND both sidecars, which is the logic that was missing.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Shared with the hoisted mock: the absolute paths each `delete()` was asked to remove.
const state = vi.hoisted(() => ({ deleted: [] as string[] }));

vi.mock('@op-engineering/op-sqlite', () => ({
  // Native `open()` is lazy and `delete()` unlinks the ONE file it was opened as, erroring if it is
  // not there (std::filesystem remove on a missing path). The mock mirrors both: remove one file,
  // throw when absent — so production's best-effort handling of a missing sidecar is load-bearing.
  open: ({ name, location }: { name: string; location?: string }) => ({
    delete: (): void => {
      const path = location === undefined ? name : `${location}/${name}`;
      state.deleted.push(path);
      if (!existsSync(path)) throw new Error(`op-sqlite remove: no such file: ${path}`);
      rmSync(path);
    },
  }),
}));

import { deleteOpSqliteDatabase } from '../src/adapters/op-sqlite.js';

const DB_NAME = 'bolusi.db';

let dir: string;
const dbPath = () => join(dir, DB_NAME);
const walPath = () => `${join(dir, DB_NAME)}-wal`;
const shmPath = () => `${join(dir, DB_NAME)}-shm`;

beforeEach(() => {
  state.deleted.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'bolusi-dbdelete-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deleteOpSqliteDatabase removes the DB file AND its WAL/SHM sidecars', () => {
  test('all three files (db, -wal, -shm) are removed — the sidecars are not left behind', () => {
    writeFileSync(dbPath(), 'main');
    writeFileSync(walPath(), 'wal');
    writeFileSync(shmPath(), 'shm');

    deleteOpSqliteDatabase({ name: DB_NAME, location: dir });

    // The outcome that matters: NO stale files survive the wipe. A `db.delete()`-only implementation
    // leaves -wal/-shm and reds exactly here (they still exist).
    expect(existsSync(dbPath())).toBe(false);
    expect(existsSync(walPath())).toBe(false);
    expect(existsSync(shmPath())).toBe(false);
    // And it did so by issuing a delete for each of the three names — the main file plus both
    // sidecars, in that order.
    expect(state.deleted).toStrictEqual([dbPath(), walPath(), shmPath()]);
  });

  test('a device with no sidecars: the main file is removed and a missing -wal/-shm is not an error', () => {
    // Best-effort: a cleanly-closed device leaves only `bolusi.db`. The sidecar deletes throw
    // (nothing to remove) and must be swallowed, not surfaced.
    writeFileSync(dbPath(), 'main');

    expect(() => deleteOpSqliteDatabase({ name: DB_NAME, location: dir })).not.toThrow();

    expect(existsSync(dbPath())).toBe(false);
    // It still ATTEMPTED all three (the loop ran) — proving the sidecar removal is not skipped when
    // the main file existed.
    expect(state.deleted).toStrictEqual([dbPath(), walPath(), shmPath()]);
  });
});
