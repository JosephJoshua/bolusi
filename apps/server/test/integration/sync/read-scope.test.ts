// Permission-scoped pull (owner decisions 2026-10-31): a shared store device is sent only what the
// business's staff roles may read or be given, the response says which read permissions it was filtered by, and
// a catch-up pull returns only the newly readable types up to where the device's normal pull was.
// Real Postgres, real routes, the production op registry's read permissions.
import type { PullResponse, SignedOperation } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { makeSyncHarness, type SeededDevice, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const NOTES_READ = 'notes.read';
const OWNER_ONLY_READ = 'auth.device_read';
const note = (title: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body: 'b' },
});

async function pullJson(res: Response): Promise<PullResponse> {
  expect(res.status).toBe(200);
  return (await res.json()) as PullResponse;
}

/** Push a genesis and `count` notes from `dev`; returns them. */
async function pushNotes(dev: SeededDevice, count: number): Promise<SignedOperation[]> {
  const ops = [
    dev.builder.genesis(),
    ...Array.from({ length: count }, (_, i) => dev.builder.append(note(`t${String(i)}`))),
  ];
  const res = await h.push(dev.auth, dev.world.deviceId, ops);
  expect(res.status).toBe(200);
  return ops;
}

/** Take `permission` away from every staff role of the tenant (an owner editing roles). */
async function revokeFromStaff(tenantId: string, permission: string): Promise<void> {
  await h.db
    .deleteFrom('rolePermissions')
    .where('tenantId', '=', tenantId)
    .where('permissionId', '=', permission)
    .where('roleId', 'in', (eb) =>
      eb
        .selectFrom('roles')
        .select('id')
        .where('tenantId', '=', tenantId)
        .where('scopeType', '=', 'store'),
    )
    .execute();
}

const typesOf = (body: PullResponse): string[] => body.ops.map((op) => op.type);

describe('a shared store device is sent what staff roles may read', () => {
  test('staff roles read notes: the notes come, and the read set says so', async () => {
    const writer = await h.seedDevice(9101);
    const reader = await h.seedDeviceIn(writer.world.tenantId, writer.world.storeId, 9102);
    await pushNotes(writer, 2);

    const body = await pullJson(
      await h.pull(reader.auth, { cursor: 0, devicesDirectoryVersion: 0 }),
    );
    expect(typesOf(body).filter((type) => type === 'notes.note_created')).toHaveLength(2);
    expect(body.readSet).toContain(NOTES_READ);
  });

  test('what a staff role can be given still comes when no staff role has it now', async () => {
    const writer = await h.seedDevice(9103);
    const reader = await h.seedDeviceIn(writer.world.tenantId, writer.world.storeId, 9104);
    await pushNotes(writer, 2);
    // Owners sign in on shared devices too (the counter PC), so taking Catatan from every staff
    // role does not take the notes off: only what no staff role can ever hold stays off.
    await revokeFromStaff(writer.world.tenantId, NOTES_READ);

    const body = await pullJson(
      await h.pull(reader.auth, { cursor: 0, devicesDirectoryVersion: 0 }),
    );
    expect(typesOf(body).filter((type) => type === 'notes.note_created')).toHaveLength(2);
    expect(typesOf(body)).toContain('auth.device_enrolled');
    expect(body.readSet).toContain(NOTES_READ);
  });
});

describe('a catch-up pull', () => {
  test('returns only the asked-for types, from its cursor through the given point', async () => {
    const writer = await h.seedDevice(9105);
    const reader = await h.seedDeviceIn(writer.world.tenantId, writer.world.storeId, 9106);
    await pushNotes(writer, 3);
    const all = await pullJson(
      await h.pull(reader.auth, { cursor: 0, devicesDirectoryVersion: 0 }),
    );
    const notes = all.ops.filter((op) => op.type === 'notes.note_created');
    // Where the normal pull stood when the read set grew: just after the second note.
    const through = all.nextCursor - 1;

    const catchUp = await pullJson(
      await h.pull(reader.auth, {
        cursor: 0,
        devicesDirectoryVersion: 0,
        backfill: { reads: [NOTES_READ], through },
      }),
    );
    expect(catchUp.ops.map((op) => op.id)).toEqual(notes.slice(0, 2).map((op) => op.id));
    expect(catchUp.hasMore).toBe(false);
  });

  test('returns nothing for a permission the device may not read', async () => {
    const writer = await h.seedDevice(9107);
    const reader = await h.seedDeviceIn(writer.world.tenantId, writer.world.storeId, 9108);
    await pushNotes(writer, 2);

    // Seeing the business's devices is the owners' alone, so a shared device is never sent it.
    const catchUp = await pullJson(
      await h.pull(reader.auth, {
        cursor: 0,
        devicesDirectoryVersion: 0,
        backfill: { reads: [OWNER_ONLY_READ], through: 1_000 },
      }),
    );
    expect(catchUp.ops).toEqual([]);
    expect(catchUp.hasMore).toBe(false);
  });
});
