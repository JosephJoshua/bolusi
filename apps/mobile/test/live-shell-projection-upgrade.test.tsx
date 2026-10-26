/**
 * PROJECTION UPGRADES IN THE BACKGROUND (04 §4.4). An app update that bumps a module's
 * projectionVersion must re-fold that module from the op log without holding the shell: `Root` starts
 * the engine's `rebuildOutdated` after boot, pausing on the injected timer between batches. Before this
 * wiring nothing on a device ever ran a rebuild, so a version bump left every device on the old fold.
 *
 * The mounted app is the real one over better-sqlite3: real migrations, registry, engine and appliers.
 */
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getNotificationChannelsAsync: vi.fn(async () => []),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: 'ExponentPushToken[upgrade]', type: 'expo' })),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import { DEFAULT_REBUILD_BATCH_SIZE, insertOpLogRow, moduleVersionSignature } from '@bolusi/core';
import { opRowOf } from '@bolusi/test-support';

import {
  bootFixture,
  closeClientDb,
  manualTimer,
  mountRoot,
  pulledNote,
  settle,
  type Fixture,
} from './live-shell-support.js';

const NOTES = DEFAULT_REBUILD_BATCH_SIZE + 5; // more than one rebuild batch
const VERSION_KEY = 'projection.notes.version';

let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
});

async function storedVersion(target: Fixture): Promise<string | null> {
  const result = await sql<{ value: string }>`
    SELECT value FROM meta_kv WHERE key = ${VERSION_KEY}
  `.execute(target.app.db.db);
  return result.rows[0]?.value ?? null;
}

async function noteCount(target: Fixture): Promise<number> {
  const result = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM notes`.execute(
    target.app.db.db,
  );
  return result.rows[0]?.c ?? 0;
}

test('a bumped projection is rebuilt in the background, batch by batch, while the shell is up', async () => {
  fixture = await bootFixture();
  const db = fixture.app.db.db;
  // Notes pulled from another device, folded by the "old" app version.
  for (let i = 0; i < NOTES; i += 1) {
    const op = {
      ...pulledNote(fixture),
      id: `op-upgrade-${String(i)}`,
      entityId: `01920000-0000-7000-8000-${(0x2000 + i).toString(16).padStart(12, '0')}`,
      seq: i + 1,
    };
    await insertOpLogRow(db, opRowOf(op), { syncStatus: 'synced', syncedAt: 1, arrivalSeq: i + 1 });
    await fixture.app.engine.applyPulledOp(op);
  }
  await sql`
    INSERT INTO meta_kv (key, value) VALUES (${VERSION_KEY}, 'notes=0')
  `.execute(db);
  const notesModule = fixture.app.registry.projections.module('notes');
  expect(notesModule).toBeDefined();
  const current = moduleVersionSignature(notesModule!);

  const timer = manualTimer();
  const screen = await mountRoot(fixture, { timer });
  await settle();

  // The shell rendered while the rebuild is parked between its batches, and the notes kept their rows.
  expect(screen.query('root-activity')).not.toBeNull();
  expect(timer.pending()).toBeGreaterThan(0);
  expect(await storedVersion(fixture)).toBe('notes=0');
  expect(await noteCount(fixture)).toBe(NOTES);

  // Let the paused batches run.
  for (let i = 0; i < 10 && (await storedVersion(fixture)) !== current; i += 1) {
    timer.fire();
    await settle();
  }
  expect(await storedVersion(fixture)).toBe(current);
  expect(await noteCount(fixture)).toBe(NOTES);
});
