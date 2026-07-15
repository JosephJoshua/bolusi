// Devices sidecar snapshot semantics (api/01-sync §4.1). The server keeps a per-tenant
// devicesDirectoryVersion (derived — see sync/pull.ts); when the client's echoed version differs,
// the pull response carries a FULL snapshot of the device's pull scope. Revoked devices remain
// listed (their historical signatures must stay verifiable) and the system device is included.
import type { DeviceInfo, PullResponse } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

async function pullJson(res: Response): Promise<PullResponse> {
  return (await res.json()) as PullResponse;
}
const idsOf = (devices: DeviceInfo[] | undefined): string[] =>
  (devices ?? []).map((d) => d.id).sort();

describe('sidecar snapshot semantics (api/01-sync §4.1)', () => {
  test('stale echo (0) → full snapshot of the pull scope + the current version', async () => {
    const a1 = await h.seedDevice(70); // tenant A, store 1
    const sys = await h.seedDeviceIn(a1.world.tenantId, null, 71, { kind: 'system' });
    const revoked = await h.seedDeviceIn(a1.world.tenantId, a1.world.storeId, 72, {
      status: 'revoked',
    });

    const body = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: 0 }));
    expect(body.devices).toBeDefined();
    expect(typeof body.devicesDirectoryVersion).toBe('number');

    // The snapshot is the device's pull scope: own store + the tenant-scoped (system) device.
    expect(idsOf(body.devices)).toEqual(
      [a1.world.deviceId, sys.world.deviceId, revoked.world.deviceId].sort(),
    );

    // The system device is carried with kind 'system' and a null store.
    const sysInfo = body.devices?.find((d) => d.id === sys.world.deviceId);
    expect(sysInfo).toMatchObject({ kind: 'system', storeId: null, status: 'active' });

    // A revoked device REMAINS listed, with its revokedAt (historical verifiability).
    const revokedInfo = body.devices?.find((d) => d.id === revoked.world.deviceId);
    expect(revokedInfo?.status).toBe('revoked');
    expect(typeof revokedInfo?.revokedAt).toBe('number');

    // Every row carries the signing key the client needs to verify pulled ops.
    for (const d of body.devices ?? []) expect(typeof d.signingKeyPublic).toBe('string');
  });

  test('echoed version current → no devices field (nothing changed)', async () => {
    const a1 = await h.seedDevice(73);
    const first = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: 0 }));
    const version = first.devicesDirectoryVersion as number;
    expect(first.devices).toBeDefined();

    const second = await pullJson(
      await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: version }),
    );
    expect(second.devices).toBeUndefined();
    expect(second.devicesDirectoryVersion).toBeUndefined();
  });

  test('version-bump: an ENROLMENT between pulls bumps the version and the next stale echo carries the new snapshot', async () => {
    const a1 = await h.seedDevice(74);
    const first = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: 0 }));
    const v1 = first.devicesDirectoryVersion as number;

    // Echoing v1 is steady-state: no snapshot.
    expect(
      (await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: v1 }))).devices,
    ).toBeUndefined();

    // Enroll a new device in the same store.
    const fresh = await h.seedDeviceIn(a1.world.tenantId, a1.world.storeId, 75);

    const after = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: v1 }));
    expect(after.devicesDirectoryVersion).toBeGreaterThan(v1); // bumped by the enrolment
    expect(idsOf(after.devices)).toContain(fresh.world.deviceId); // new snapshot carries it
  });

  test('version-bump: a REVOCATION between pulls bumps the version and the device stays listed', async () => {
    const a1 = await h.seedDevice(76);
    const peer = await h.seedDeviceIn(a1.world.tenantId, a1.world.storeId, 77);
    const first = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: 0 }));
    const v1 = first.devicesDirectoryVersion as number;

    await h.revokeDevice(peer.world.deviceId);

    const after = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: v1 }));
    expect(after.devicesDirectoryVersion).toBeGreaterThan(v1); // bumped by the revocation
    const peerInfo = after.devices?.find((d) => d.id === peer.world.deviceId);
    expect(peerInfo?.status).toBe('revoked');
    expect(peerInfo?.revokedAt).not.toBeNull(); // still listed, with its revocation time
  });

  test('snapshot never contains another store’s or another tenant’s devices', async () => {
    const a1 = await h.seedDevice(78); // tenant A, store 1
    const store2 = await h.seedStore(a1.world.tenantId, 79);
    const a2 = await h.seedDeviceIn(a1.world.tenantId, store2, 80); // tenant A, store 2
    const b = await h.seedDevice(81); // tenant B

    const body = await pullJson(await h.pull(a1.auth, { cursor: 0, devicesDirectoryVersion: 0 }));
    const ids = idsOf(body.devices);
    expect(ids).toContain(a1.world.deviceId); // own store — the positive control
    expect(ids).not.toContain(a2.world.deviceId); // other store of the same tenant
    expect(ids).not.toContain(b.world.deviceId); // other tenant (RLS)
    for (const d of body.devices ?? []) expect([a1.world.storeId, null]).toContain(d.storeId);
  });
});
