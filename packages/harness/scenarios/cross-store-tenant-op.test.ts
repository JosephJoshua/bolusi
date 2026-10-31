// A tenant-wide op written at one store reaches a device at another store.
//
// Ops with `storeId = null` (a user's locale, tenant inventory, central money accounts, intake
// options) are pulled by every device of the tenant. The pulling device verifies each op against
// the devices list the pull returns, so that list must carry the author's key even when the author
// works at another store. When it carried only the puller's own store, the store-A device could not
// verify store B's tenant op: it refetched the list, still found no key, and quarantined the op for
// good. This drives the real server and the real client pull (runPullPhase) end to end.
import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { PLATFORM_OP, platformModule, platformModuleManifest } from '@bolusi/core';
import { ChainBuilder, FakeClock, makeWorld, mulberry32, noblePort } from '@bolusi/test-support';

import { VirtualDevice, type DeviceIdentity, type ExtraModule } from '../src/device.js';
import { mintIdentities } from '../src/identities.js';
import { HarnessServer } from '../src/server.js';
import { HttpTransport, pullDevice } from '../src/transport.js';

const CLOCK_BASE = 1_726_100_000_000;

const platformExtra = {
  module: platformModule,
  permissionManifest: platformModuleManifest,
} as unknown as ExtraModule;

test('a tenant-wide op signed at store B folds on a store-A device instead of being quarantined', async () => {
  const server = await HarnessServer.boot();
  server.clock.set(CLOCK_BASE + 3_600_000);
  try {
    // Store A: one device, opened through the real client runtime with the platform module.
    const run = mintIdentities(0x5b0a, 1);
    const aIdentity = run.devices[0]!;
    const aSeeded = await server.seedDevice(aIdentity);
    const deviceA = await VirtualDevice.open({
      identity: aIdentity,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(0x5b0a),
      extraModules: [platformExtra],
    });

    try {
      // Store B of the SAME tenant: its own device and user.
      const bRaw = makeWorld(0x5b0b, noblePort);
      const bWorld = { ...bRaw, tenantId: run.tenantId };
      expect(bWorld.storeId).not.toBe(aIdentity.storeId);
      const bIdentity: DeviceIdentity = {
        tenantId: bWorld.tenantId,
        storeId: bWorld.storeId,
        userId: bWorld.userId,
        deviceId: bWorld.deviceId,
        seed: bWorld.secretKey,
        publicKey: bWorld.publicKey,
        publicKeyBase64: bWorld.publicKeyB64,
      };
      const bSeeded = await server.seedDevice(bIdentity);

      // Store B's user changes their language: a tenant-scoped op (storeId null).
      const builder = new ChainBuilder(bWorld, noblePort, CLOCK_BASE);
      const genesis = builder.genesis();
      const locale = builder.append({
        type: PLATFORM_OP.userLocaleChanged,
        entityType: 'user_pref',
        entityId: bWorld.userId,
        storeId: null,
        payload: { locale: 'en' },
      });
      const pushed = await new HttpTransport(server.fetch, bSeeded.auth).push({
        deviceId: bWorld.deviceId,
        ops: [genesis, locale],
      });
      expect(pushed.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);

      // The store-A device pulls. Store B's genesis is store-scoped, so only the locale op is served.
      const result = await pullDevice(deviceA, new HttpTransport(server.fetch, aSeeded.auth));

      expect(result.quarantined).toBe(0);
      expect(result.applied).toBe(1);
      const prefs = await sql<{ userId: string; locale: string }>`
        SELECT user_id, locale FROM user_prefs`.execute(deviceA.db);
      expect(prefs.rows).toEqual([{ userId: bWorld.userId, locale: 'en' }]);
      const quarantined = await sql<{ n: number }>`
        SELECT count(*) AS n FROM quarantined_ops`.execute(deviceA.db);
      expect(Number(quarantined.rows[0]!.n)).toBe(0);
    } finally {
      await deviceA.close();
    }
  } finally {
    await server.close();
  }
});
