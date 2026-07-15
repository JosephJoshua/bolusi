// Request-scoped tenant helper (api/00 §3.1, 10-db-schema §6). Two layers of proof:
//  - UNIT: the helper derives tenantId ONLY from the bearer context — a body/path/header tenant
//    is structurally inaccessible to it (its signature is (c, fn)); it delegates to the injected
//    forTenant with exactly the context tenant id.
//  - L3 (PGlite): driving the real helper through a PGlite-backed forTenant, the transaction's
//    FIRST statement is `set_config('app.tenant_id', $1, true)` (id bound, not interpolated) and
//    current_setting inside the callback equals the context tenant id.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import type { ForTenant, TenantDb } from '@bolusi/db-server';
import type { Context } from 'hono';

import type { AppEnv } from '../../src/env.js';
import { ApiError } from '../../src/errors.js';
import { createWithTenant, tenantIdFromContext } from '../../src/tenant.js';
import { makeFixture } from '../helpers/fixtures.js';
import { makePgliteForTenant, type PgliteTenant } from '../helpers/pglite-tenant.js';

function ctxWithDevice(tenantId: string): Context<AppEnv> {
  return {
    get: (key: string) =>
      key === 'device' ? { deviceId: 'dev', tenantId, storeId: null } : undefined,
  } as unknown as Context<AppEnv>;
}

function ctxWithControl(tenantId: string): Context<AppEnv> {
  return {
    get: (key: string) => (key === 'controlSession' ? { userId: 'u', tenantId } : undefined),
  } as unknown as Context<AppEnv>;
}

function ctxEmpty(): Context<AppEnv> {
  return { get: () => undefined } as unknown as Context<AppEnv>;
}

describe('tenantIdFromContext derives from the bearer principal only', () => {
  test('device principal → device.tenantId', () => {
    const fx = makeFixture('tid-dev');
    expect(tenantIdFromContext(ctxWithDevice(fx.tenantId))).toBe(fx.tenantId);
  });

  test('control-session principal → controlSession.tenantId', () => {
    const fx = makeFixture('tid-ctrl');
    expect(tenantIdFromContext(ctxWithControl(fx.tenantId))).toBe(fx.tenantId);
  });

  test('no principal → throws INTERNAL (a routing/middleware bug, not tenant "undefined")', () => {
    expect(() => tenantIdFromContext(ctxEmpty())).toThrow(ApiError);
  });
});

describe('createWithTenant delegates the context tenant id to forTenant (unit)', () => {
  test('the tenant id passed to forTenant is exactly the context device tenant', async () => {
    const seen: string[] = [];
    const spy: ForTenant = async (tenantId, fn) => {
      seen.push(tenantId);
      return fn(undefined as unknown as TenantDb);
    };
    const withTenant = createWithTenant(spy);

    const a = makeFixture('wt-a');
    const b = makeFixture('wt-b');
    await withTenant(ctxWithDevice(a.tenantId), async () => 'ok');
    await withTenant(ctxWithControl(b.tenantId), async () => 'ok');

    // Distinct contexts → distinct tenant ids, proving the id tracks the context and nothing else.
    expect(seen).toEqual([a.tenantId, b.tenantId]);
  });

  test('the callback result propagates', async () => {
    const spy: ForTenant = async (_t, fn) => fn(undefined as unknown as TenantDb);
    const withTenant = createWithTenant(spy);
    const out = await withTenant(ctxWithDevice(makeFixture('wt-c').tenantId), async () => 123);
    expect(out).toBe(123);
  });
});

describe('L3: the first statement is set_config against real Postgres (PGlite)', () => {
  let pg: PgliteTenant | undefined;
  afterEach(async () => {
    await pg?.close();
    pg = undefined;
  });

  test('set_config is first, id bound as $1, and current_setting equals the context tenant', async () => {
    pg = await makePgliteForTenant();
    const withTenant = createWithTenant(pg.forTenant);
    const fx = makeFixture('wt-l3');

    const guc = await withTenant(ctxWithDevice(fx.tenantId), async (db) => {
      const { rows } = await sql<{
        g: string;
      }>`SELECT current_setting('app.tenant_id') AS g`.execute(db);
      return rows[0]?.g;
    });

    // The GUC the callback sees is the CONTEXT tenant — the real proof the helper wired it through.
    expect(guc).toBe(fx.tenantId);

    const first = pg.statements[0];
    expect(first).toContain('set_config');
    expect(first).toContain('app.tenant_id');
    expect(first).toContain('$1'); // bound parameter…
    expect(first).not.toContain(fx.tenantId); // …never interpolated into the SQL text
    expect(first).toMatch(/set_config\('app\.tenant_id', \$1, true\)/); // transaction-local (is_local = true)
  });
});
