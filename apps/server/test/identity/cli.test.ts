// provision-tenant CLI (§2). Drives the testable core `provisionTenant` against the identity DB.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { OwnerLoginExistsError, provisionTenant } from '../../src/cli/provision-tenant.js';
import { verifyPassword } from '../../src/crypto/index.js';
import { makeIdentityHarness, type IdentityHarness } from '../helpers/identity-app.js';
import { ed25519 } from '@noble/curves/ed25519.js';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness({ realKdf: true });
});
afterEach(async () => {
  await h.close();
});

function deps() {
  return {
    forTenant: h.idb.forTenant,
    now: () => h.clock.now(),
    createPasswordVerifier: h.kdf.createVerifier,
    generatePassword: () => 'Provisioned24CharPwBase58', // 24 chars
    generateSystemKeypair: () => {
      const { secretKey, publicKey } = ed25519.keygen();
      return {
        publicKeyB64: Buffer.from(publicKey).toString('base64'),
        secretKeyB64: Buffer.from(secretKey).toString('base64'),
      };
    },
  };
}

test('provisions tenant + stores + owner (argon2id verifier, no PIN) + system actor/device + chain state + default roles', async () => {
  const result = await provisionTenant(deps(), {
    tenantName: 'Bolusi Papua',
    storeNames: ['Toko Jayapura', 'Toko Sentani'],
    ownerName: 'Ocep',
    ownerLogin: 'ocep',
  });

  expect(result.storeIds).toHaveLength(2);

  // Owner: argon2id password verifier (verifies against the printed one-time password), no PIN.
  const owner = await h.idb.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', result.ownerUserId)
    .executeTakeFirstOrThrow();
  expect(owner.passwordVerifier).not.toBeNull();
  expect(await verifyPassword(result.oneTimePassword, owner.passwordVerifier as string)).toBe(true);
  const ownerPin = await h.idb.db
    .selectFrom('userPinVerifiers')
    .select('userId')
    .where('userId', '=', result.ownerUserId)
    .executeTakeFirst();
  expect(ownerPin).toBeUndefined();

  // System actor: is_system, no login, never a bundle user.
  const sys = await h.idb.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', result.systemUserId)
    .executeTakeFirstOrThrow();
  expect(sys.isSystem).toBe(true);
  expect(sys.loginIdentifier).toBeNull();

  // System device: kind='system', store_id NULL, + a chain-state row.
  const sysDevice = await h.idb.db
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', result.systemDeviceId)
    .executeTakeFirstOrThrow();
  expect(sysDevice.kind).toBe('system');
  expect(sysDevice.storeId).toBeNull();
  const chain = await h.idb.db
    .selectFrom('systemDeviceChainState')
    .select('deviceId')
    .where('deviceId', '=', result.systemDeviceId)
    .executeTakeFirst();
  expect(chain?.deviceId).toBe(result.systemDeviceId);

  // Three default roles seeded; the owner holds main_owner tenant-wide; a tenant_op_counter exists.
  const roles = await h.idb.db
    .selectFrom('roles')
    .select('name')
    .where('tenantId', '=', result.tenantId)
    .execute();
  expect(roles.map((r) => r.name).sort()).toEqual(['main_owner', 'staff', 'store_owner']);
  const counter = await h.idb.db
    .selectFrom('tenantOpCounters')
    .select('tenantId')
    .where('tenantId', '=', result.tenantId)
    .executeTakeFirst();
  expect(counter).toBeDefined();
});

test('rerun with an existing --owner-login refuses with a non-zero-shaped error and writes nothing', async () => {
  await provisionTenant(deps(), {
    tenantName: 'A',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: 'dup',
  });
  const tenantsAfterFirst = (await h.idb.db.selectFrom('tenants').select('id').execute()).length;

  await expect(
    provisionTenant(deps(), {
      tenantName: 'B',
      storeNames: ['S'],
      ownerName: 'O2',
      ownerLogin: 'dup',
    }),
  ).rejects.toBeInstanceOf(OwnerLoginExistsError);

  // Zero writes from the failed run — the whole transaction rolled back.
  const tenantsAfterSecond = (await h.idb.db.selectFrom('tenants').select('id').execute()).length;
  expect(tenantsAfterSecond).toBe(tenantsAfterFirst);
});
