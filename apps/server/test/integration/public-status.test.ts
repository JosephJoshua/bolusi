// GET /v1/public/status/:code: a customer's status page reads a servisan the store pushed, by the
// link code made at intake, with no token, on real PostgreSQL. Only the customer's view comes back,
// a page closes a while after the warranty ends, and the lookup is limited per IP.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import {
  INTAKE_PHOTO_SLOTS,
  displayStatusCode,
  formatTicketNumber,
  statusCodeFor,
} from '@bolusi/modules/repair';
import { STATUS_PAGE_GRACE_MS, zPublicRepairStatus, type MediaRef } from '@bolusi/schemas';
import { ChainBuilder, makeWorld, type ChainWorld, type OpSpec } from '@bolusi/test-support';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect, inject, test } from 'vitest';

import { createApp } from '../../src/app.js';
import type { AuthDirectory } from '../../src/auth/directory.js';
import { resolveDeps, SERVER_MODULES } from '../../src/deps.js';
import { serverCryptoPort } from '../../src/oplog/crypto.js';
import { processPushBatch } from '../../src/oplog/pipeline.js';
import { InMemoryRateLimitStore } from '../../src/middleware/rate-limit.js';
import { PUBLIC_STATUS_IP_PER_MINUTE } from '../../src/routes/public-status.js';
import { grantRole, seedWorld } from './oplog/helpers.js';
import { readError } from '../helpers/http.js';

const NOW = 1_726_100_000_000;
/** The nonce a phone drew for a servisan's link; the code comes from it and where the servisan lives. */
const NONCE = '0123456789abcdef'.repeat(2);
const BASE = 'http://srv.test/v1/public/status';

let db: Kysely<DB>;
let appForTenant: ForTenant;
let closeDb: (() => Promise<void>) | undefined;

function forTenantOn(handle: Kysely<DB>): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

beforeEach(async () => {
  const handle = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );
  db = handle.db;
  closeDb = handle.close;
  appForTenant = forTenantOn(db);
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
});

/** Ids of one tenant's records, apart from every other tenant's in the same database. */
const idsOf =
  (seed: number) =>
  (n: number): string =>
    `01920000-0000-7000-8${(seed % 4096).toString(16).padStart(3, '0')}-0000000d${n.toString(16).padStart(4, '0')}`;

/** Only the status link lookup is reachable without a token; the rest would be a wiring bug here. */
const directory: AuthDirectory = {
  findDeviceByTokenHash: () => Promise.reject(new Error('no tokens in this suite')),
  findControlSessionByTokenHash: () => Promise.reject(new Error('no tokens in this suite')),
  findLoginCredential: () => Promise.reject(new Error('no tokens in this suite')),
  async findStatusLink(code) {
    const { rows } = await sql<{
      tenantId: string;
      storeId: string;
      ticketId: string;
    }>`SELECT * FROM public_find_status_link(${code})`.execute(db);
    return rows.length === 1 ? rows[0] : undefined;
  },
};

function app(now = NOW, perIpStore = new InMemoryRateLimitStore()) {
  return createApp({
    forTenant: appForTenant,
    authDirectory: directory,
    now: () => now,
    perIpStore,
    clientIp: () => '203.0.113.7',
  });
}

/**
 * A servisan taken in with a DP and a status link, started, with a price change waiting: the world,
 * its link code, and what the server said to the link op. `claim` pushes that code for the link
 * instead of the one its nonce gives, as a copier would.
 */
async function pushServisan(
  seed: number,
  claim?: string,
): Promise<{ world: ChainWorld; code: string; linkStatus: string }> {
  const id = idsOf(seed);
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  await seedWorld(db, world);
  await grantRole(db, {
    tenantId: world.tenantId,
    userId: world.userId,
    roleId: id(seed),
    roleName: 'store_owner',
    permissionIds: SERVER_MODULES.flatMap((module) => Object.keys(module.permissions ?? {})),
  });
  const photo = (n: number): MediaRef => ({
    mediaId: id(0x100 + n),
    sha256: 'd'.repeat(64),
    mime: 'image/jpeg',
    type: 'image',
    sizeBytes: 50_000,
    capturedAt: 1_726_000_000_000,
    location: null,
    userId: world.userId,
    deviceId: world.deviceId,
  });
  const ticket = id(2);
  const owner = { tenantId: world.tenantId, storeId: world.storeId, ticketId: ticket };
  const code = statusCodeFor(owner, NONCE, (data) => serverCryptoPort.sha256(data));
  const ticketNumber = formatTicketNumber(world.deviceId, 1);
  const onTicket = (type: string, payload: Record<string, unknown>): OpSpec => ({
    type,
    entityType: 'repair_ticket',
    entityId: ticket,
    payload,
  });
  const specs: OpSpec[] = [
    {
      type: 'repair.store_print_settings_changed',
      entityType: 'repair_store_print_settings',
      entityId: world.storeId,
      payload: {
        name: 'Bolusi Cell Sorong',
        address: 'Jl. Basuki Rahmat No. 12',
        phone: '0812-4800-1234',
        logo: null,
        logoOnDotMatrix: false,
        intakeTerms: null,
        handoverTerms: null,
      },
    },
    {
      type: 'repair.customer_registered',
      entityType: 'repair_customer',
      entityId: id(1),
      payload: { name: 'Yohanis Wenda', phone: '081234567890' },
    },
    {
      ...onTicket('repair.ticket_opened', {
        ticketNumber,
        customerId: id(1),
        device: {
          brand: 'Samsung',
          model: 'Galaxy A14',
          color: 'Hitam',
          imei: null,
          passcode: '987654',
        },
        complaint: 'Layar retak',
        intakeNotes: 'Pelanggan minta cepat',
        checklist: [{ item: 'screen', label: null, state: 'issue', note: '' }],
        peripherals: [],
        estimatedReadyAt: 1_726_200_000_000,
        quoteLines: [{ lineId: id(0x200), kind: 'part', description: 'LCD', amount: 650_000 }],
        photos: INTAKE_PHOTO_SLOTS.map((slot, i) => ({ slot, label: null, ref: photo(0x10 + i) })),
        repairTypes: [{ item: 'screen', label: null, warrantyDays: 30, needsVideo: false }],
        claimOf: null,
        ownershipVideo: null,
      }),
      schemaVersion: 4,
    },
    onTicket('repair.status_link_made', { code: claim ?? code, nonce: NONCE }),
    {
      type: 'money.payment_received',
      entityType: 'money_entry',
      entityId: id(0x400),
      payload: {
        document: { kind: 'repair.ticket', id: ticket, label: ticketNumber },
        account: 'cash',
        amount: 100_000,
        reference: null,
        tendered: null,
      },
    },
    onTicket('repair.ticket_claimed', {}),
    onTicket('repair.work_photos_added', { stage: 'before', photos: [photo(2)] }),
    onTicket('repair.work_started', {}),
    onTicket('repair.quote_change_proposed', {
      lineId: id(0x201),
      kind: 'part',
      description: 'Baterai',
      amount: 250_000,
      reason: 'Baterai kembung',
    }),
  ];
  const ops = [builder.genesis(), ...specs.map((spec) => builder.append(spec))];
  const deps = resolveDeps({ forTenant: appForTenant, now: () => NOW });
  const result = await processPushBatch(
    {
      forTenant: deps.forTenant,
      crypto: deps.serverCrypto,
      now: deps.now,
      newId: deps.newOpLogId,
      registry: deps.opRegistry,
      projections: deps.projections,
    },
    { deviceId: world.deviceId, tenantId: world.tenantId },
    ops,
  );
  const linkAt = specs.findIndex((spec) => spec.type === 'repair.status_link_made') + 1;
  expect(result.results.filter((r, i) => i !== linkAt && r.status !== 'accepted')).toEqual([]);
  return { world, code, linkStatus: result.results[linkAt]!.status };
}

test('a link code shows the customer their servisan, without a token', async () => {
  const { world, code } = await pushServisan(4101);

  const res = await app().request(`${BASE}/${code}`);

  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex');
  const body: unknown = await res.json();
  const status = zPublicRepairStatus.parse(body);
  expect(status).toEqual({
    store: {
      name: 'Bolusi Cell Sorong',
      address: 'Jl. Basuki Rahmat No. 12',
      phone: '0812-4800-1234',
    },
    ticketNumber: formatTicketNumber(world.deviceId, 1),
    device: 'Samsung Galaxy A14',
    status: 'in_repair',
    steps: [
      { step: 'received', at: expect.any(Number) },
      { step: 'in_repair', at: expect.any(Number) },
    ],
    estimatedReadyAt: 1_726_200_000_000,
    money: { total: 650_000, paid: 100_000 },
    pendingPrices: [{ description: 'Baterai', amount: 250_000 }],
    repairTypes: [{ item: 'screen', label: null, warrantyDays: 30 }],
    returnedAt: null,
    updatedAt: expect.any(Number),
  });
  // Nothing the customer was not given: no name, phone, unlock code, notes or staff.
  const text = JSON.stringify(body);
  for (const secret of ['Yohanis', '081234567890', '987654', 'Pelanggan minta', 'kembung']) {
    expect(text).not.toContain(secret);
  }
});

test('a code typed from paper is read the way Crockford base32 allows', async () => {
  const { code } = await pushServisan(4102);

  const res = await app().request(`${BASE}/${displayStatusCode(code).toLowerCase()}`);

  expect(res.status).toBe(200);
});

test('an unknown or malformed code finds nothing', async () => {
  const { code: real } = await pushServisan(4103);

  for (const code of [
    real === 'K7M2Q9XA4BRS' ? 'K7M2Q9XA4BRT' : 'K7M2Q9XA4BRS',
    'nope',
    `${real}0`,
  ]) {
    const res = await app().request(`${BASE}/${code}`);
    expect(res.status, code).toBe(404);
    expect((await readError(res)).error.code).toBe('NOT_FOUND');
  }
});

test('each tenant’s code shows its own servisan, even from the same nonce', async () => {
  const a = await pushServisan(4104);
  const b = await pushServisan(4105);
  expect(a.code).not.toBe(b.code);

  const fromA = zPublicRepairStatus.parse(await (await app().request(`${BASE}/${a.code}`)).json());
  const fromB = zPublicRepairStatus.parse(await (await app().request(`${BASE}/${b.code}`)).json());

  expect(fromA.ticketNumber).toBe(formatTicketNumber(a.world.deviceId, 1));
  expect(fromB.ticketNumber).toBe(formatTicketNumber(b.world.deviceId, 1));
});

test('a code copied off a slip cannot be recorded by another tenant', async () => {
  const victim = await pushServisan(4108);

  // The code must be the one the op's nonce gives the copier's own servisan, so it is refused.
  const copier = await pushServisan(4109, victim.code);

  expect(copier.linkStatus).not.toBe('accepted');
  const page = zPublicRepairStatus.parse(
    await (await app().request(`${BASE}/${victim.code}`)).json(),
  );
  expect(page.ticketNumber).toBe(formatTicketNumber(victim.world.deviceId, 1));
});

test('the page closes 30 days after the warranty from pickup ends', async () => {
  const { code } = await pushServisan(4106);
  const pickedUp = NOW;
  // The server folds what the store pushed; a pickup is set here directly to keep the journey short.
  await db
    .updateTable('repairTickets')
    .set({ location: 'returned', returnedAt: BigInt(pickedUp) })
    .where('statusCode', '=', code)
    .execute();
  const warrantyEnds = pickedUp + 30 * 24 * 60 * 60 * 1000;

  const open = await app(warrantyEnds + STATUS_PAGE_GRACE_MS).request(`${BASE}/${code}`);
  const closed = await app(warrantyEnds + STATUS_PAGE_GRACE_MS + 1).request(`${BASE}/${code}`);

  expect(open.status).toBe(200);
  expect(zPublicRepairStatus.parse(await open.json()).status).toBe('returned');
  expect(closed.status).toBe(404);
  expect((await readError(closed)).error.details).toEqual({ reason: 'ended' });
});

test('lookups are limited per IP', async () => {
  const { code } = await pushServisan(4107);
  const store = new InMemoryRateLimitStore();
  const server = app(NOW, store);

  for (let i = 0; i < PUBLIC_STATUS_IP_PER_MINUTE; i += 1) {
    expect((await server.request(`${BASE}/K7M2Q9XA4BRT`)).status).toBe(404);
  }
  const limited = await server.request(`${BASE}/${code}`);

  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).not.toBeNull();
});
