// `resolveDisplayRoleKeys` — the switcher card's role line (design-system §8.2, task 129 item 6).
//
// The card shows a user's TOP-PRIVILEGE role, and privilege is measured STRUCTURALLY: the breadth of
// a role's `permission_ids` set. 02-permissions §12 is a strict superset chain (main_owner ⊃
// store_owner ⊃ staff), so a larger permission set is unambiguously more privileged and no roleKey is
// hardcoded here. These tests drive the real client directory (real migrations, real bundle apply)
// and add extra grants to prove the four behaviours that a single-role fixture cannot: precedence,
// ties-list-all, cross-store dedup, and no-grant ⇒ empty.
import { afterEach, describe, expect, it } from 'vitest';

import { resolveDisplayRoleKeys } from '../../src/index.js';
import type { ClientDatabase } from '@bolusi/db-client';
import type { Kysely } from 'kysely';

import { openAuthHarness, type AuthHarness } from './_harness.js';

let harness: AuthHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function open(seed: number): Promise<AuthHarness> {
  const h = await openAuthHarness(seed);
  harness = h;
  return h;
}

/** The generated `roles_directory.id` for a seeded roleKey (the id is opaque; the name is the key). */
async function roleIdOf(db: Kysely<ClientDatabase>, roleKey: string): Promise<string> {
  const row = await db
    .selectFrom('rolesDirectory')
    .select('id')
    .where('name', '=', roleKey)
    .executeTakeFirstOrThrow();
  return row.id as string;
}

/** Insert a bespoke role with an explicit permission breadth — for the tie / low-rank cases. */
async function insertRole(
  db: Kysely<ClientDatabase>,
  id: string,
  name: string,
  permissionCount: number,
): Promise<void> {
  const permissionIds = Array.from({ length: permissionCount }, (_, i) => `${name}.p${i}`);
  await db
    .insertInto('rolesDirectory')
    .values({
      id,
      name,
      scopeType: 'store',
      isSystemDefault: 0,
      permissionIds: JSON.stringify(permissionIds),
    })
    .execute();
}

async function grant(
  db: Kysely<ClientDatabase>,
  userId: string,
  roleId: string,
  storeId: string | null,
): Promise<void> {
  await db.insertInto('userRolesDirectory').values({ userId, roleId, storeId }).execute();
}

describe('resolveDisplayRoleKeys — top-privilege role selection (design-system §8.2)', () => {
  it('a single-role user maps to that roleKey', async () => {
    const h = await open(1);
    expect(await resolveDisplayRoleKeys(h.db, h.ownerId)).toEqual(['main_owner']);
    expect(await resolveDisplayRoleKeys(h.db, h.storeOwnerId)).toEqual(['store_owner']);
    expect(await resolveDisplayRoleKeys(h.db, h.staffId)).toEqual(['staff']);
  });

  it('picks the broader role when a user holds two: store_owner OVER staff', async () => {
    const h = await open(2);
    // Budi (staff) is additionally granted store_owner. store_owner's permission set is a strict
    // superset of staff's (§12), so the card must show ONLY store_owner — never staff, never both.
    await grant(h.db, h.staffId, await roleIdOf(h.db, 'store_owner'), h.storeId);
    expect(await resolveDisplayRoleKeys(h.db, h.staffId)).toEqual(['store_owner']);
  });

  it('lists ALL roles tied at the top rank, dropping any lower one', async () => {
    const h = await open(3);
    const userId = 'u-tie';
    // Two distinct roles of EQUAL breadth (2) and one narrower (1). The owner ruling's "parallel at
    // the top ⇒ list all" means both breadth-2 roles show; the breadth-1 role is dropped.
    await insertRole(h.db, 'role-a', 'alpha_lead', 2);
    await insertRole(h.db, 'role-b', 'beta_lead', 2);
    await insertRole(h.db, 'role-c', 'gamma_helper', 1);
    await grant(h.db, userId, 'role-a', h.storeId);
    await grant(h.db, userId, 'role-b', h.storeId);
    await grant(h.db, userId, 'role-c', h.storeId);
    expect([...(await resolveDisplayRoleKeys(h.db, userId))].sort()).toEqual([
      'alpha_lead',
      'beta_lead',
    ]);
  });

  it('DEDUPES one role held across several stores into a single label', async () => {
    const h = await open(4);
    const userId = 'u-multistore';
    const storeOwnerRoleId = await roleIdOf(h.db, 'store_owner');
    // Same role, two stores → two grant tuples, one label (DISTINCT in the query).
    await grant(h.db, userId, storeOwnerRoleId, h.storeId);
    await grant(h.db, userId, storeOwnerRoleId, 'store-other');
    expect(await resolveDisplayRoleKeys(h.db, userId)).toEqual(['store_owner']);
  });

  it('returns [] for a user with no role grant — the card shows no role line', async () => {
    const h = await open(5);
    expect(await resolveDisplayRoleKeys(h.db, 'nobody-here')).toEqual([]);
  });
});
