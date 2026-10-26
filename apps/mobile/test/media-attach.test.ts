// A capture becomes uploadable only once the op that references it is appended (06 §4, 04 §5.1
// step 5). This drives the real app runtime: a note created with a photo attaches that photo's
// media row to the note's op, and a capture no op referenced stays an orphan the drain ignores.
import { vi } from 'vitest';

// The native modules the shell fixture's import graph reaches, doubled as the live-shell tests do.
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
}));
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import { bindModulePort } from '@bolusi/core';
import { notesModule } from '@bolusi/modules/notes';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { insertMediaItem } from '../src/media/queue.js';

import {
  bootFixture,
  enrolledDevice,
  runtimeFor,
  seedDirectory,
  type Fixture,
} from './live-shell-support.js';

const PHOTO = '01920000-0000-7000-8000-0000000140a1';
const ORPHAN = '01920000-0000-7000-8000-0000000140a2';

let fixture: Fixture;

beforeEach(async () => {
  fixture = await bootFixture();
  await enrolledDevice(fixture);
  await seedDirectory(fixture);
});

afterEach(async () => {
  await fixture.close();
});

async function capture(id: string, userId = fixture.userId): Promise<void> {
  await insertMediaItem(fixture.app.db.db, {
    id,
    tenantId: fixture.tenantId,
    storeId: fixture.storeId,
    userId,
    deviceId: fixture.deviceId,
    type: 'image',
    mime: 'image/jpeg',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    capturedAt: 1,
    location: null,
    localPath: `/tmp/${id}.jpg`,
  });
}

async function attachedTo(id: string): Promise<string | null> {
  const rows = await sql<{ op: string | null }>`
    SELECT attached_to_operation_id AS op FROM media_items WHERE id = ${id}
  `.execute(fixture.app.db.db);
  return rows.rows[0]?.op ?? null;
}

test('appending an op attaches every media ref in its payload, and only those', async () => {
  await capture(PHOTO);
  await capture(ORPHAN);
  const identity = {
    tenantId: fixture.tenantId,
    storeId: fixture.storeId,
    deviceId: fixture.deviceId,
    userId: fixture.userId,
  };
  const app = runtimeFor(fixture.app);
  await app.evaluator.prime();
  const port = bindModulePort(notesModule, app.moduleRuntimeFor(identity), identity);

  await port.run('createNote', {
    title: 'Foto',
    body: '',
    mediaRef: {
      mediaId: PHOTO,
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      sizeBytes: 1024,
      capturedAt: 1,
      location: null,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
    },
  });

  const op = await sql<{ id: string }>`
    SELECT id FROM operations WHERE type = 'notes.note_created'
  `.execute(fixture.app.db.db);
  expect(await attachedTo(PHOTO)).toBe(op.rows[0]?.id);
  expect(await attachedTo(ORPHAN)).toBeNull();
});

test('a ref only attaches the capture it describes, taken by the user who signed the op', async () => {
  const OTHER_USERS = '01920000-0000-7000-8000-0000000140a3';
  const WRONG_HASH = '01920000-0000-7000-8000-0000000140a4';
  await capture(OTHER_USERS, '01920000-0000-7000-8000-0000000140f9');
  await capture(WRONG_HASH);
  const identity = {
    tenantId: fixture.tenantId,
    storeId: fixture.storeId,
    deviceId: fixture.deviceId,
    userId: fixture.userId,
  };
  const app = runtimeFor(fixture.app);
  await app.evaluator.prime();
  const port = bindModulePort(notesModule, app.moduleRuntimeFor(identity), identity);
  const refTo = (mediaId: string, sha256: string) => ({
    mediaId,
    sha256,
    mime: 'image/jpeg' as const,
    type: 'image' as const,
    sizeBytes: 1024,
    capturedAt: 1,
    location: null,
    userId: fixture.userId,
    deviceId: fixture.deviceId,
  });

  await port.run('createNote', {
    title: 'A',
    body: '',
    mediaRef: refTo(OTHER_USERS, 'a'.repeat(64)),
  });
  await port.run('createNote', {
    title: 'B',
    body: '',
    mediaRef: refTo(WRONG_HASH, 'b'.repeat(64)),
  });

  expect(await attachedTo(OTHER_USERS)).toBeNull();
  expect(await attachedTo(WRONG_HASH)).toBeNull();
});

test('an append that attaches media tells the media drain, and one without media does not', async () => {
  await capture(PHOTO);
  const identity = {
    tenantId: fixture.tenantId,
    storeId: fixture.storeId,
    deviceId: fixture.deviceId,
    userId: fixture.userId,
  };
  const app = runtimeFor(fixture.app);
  await app.evaluator.prime();
  let notified = 0;
  app.bindMediaAttached(() => {
    notified += 1;
  });
  const port = bindModulePort(notesModule, app.moduleRuntimeFor(identity), identity);

  await port.run('createNote', { title: 'Tanpa foto', body: '' });
  expect(notified).toBe(0);
  await port.run('createNote', {
    title: 'Foto',
    body: '',
    mediaRef: {
      mediaId: PHOTO,
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      sizeBytes: 1024,
      capturedAt: 1,
      location: null,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
    },
  });
  expect(notified).toBe(1);
});
