// Parts sent between stores over the real HTTP surface and PG16 (owner decisions 2026-11-25). A
// device pulls its own store's ops and the tenant's; a transfer must also reach the store it names
// (`OperationDeclaration.otherStore`) with the movements its parts left the sender's stock in, so
// the receiver can take in only what really left; and its arrival must reach the sender. Nothing
// else of the sender's crosses: its counts and other movements stay with its own store.
//
// The second store an op names is read from its payload, so the server checks it: a store of this
// business and not the op's own, else SCOPE_VIOLATION (a tampered phone cannot widen who pulls it).
import { formatTicketNumber } from '@bolusi/modules/repair';
import type { SignedOperation } from '@bolusi/schemas';
import { type ChainBuilder, type ChainWorld } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverOpRegistry } from '../../../src/deps.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;

beforeEach(async () => {
  h = await makeSyncHarness({ registry: serverOpRegistry });
}, 120_000);

afterEach(async () => {
  await h.close();
});

interface PushResult {
  readonly id: string;
  readonly status: string;
  readonly code?: string;
}

async function push(
  device: { auth: string; world: ChainWorld },
  ops: readonly SignedOperation[],
): Promise<readonly PushResult[]> {
  const response = await h.push(device.auth, device.world.deviceId, ops);
  expect(response.status).toBe(200);
  return ((await response.json()) as { results: readonly PushResult[] }).results;
}

async function pulledTypes(auth: string): Promise<string[]> {
  const response = await h.pull(auth, { cursor: 0, devicesDirectoryVersion: 0 });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ops: readonly { type: string }[] };
  return body.ops.map((op) => op.type);
}

/** Store A (with a part counted to 10) and store B of one business, a device in each. */
async function twoStores(seed: number) {
  const a = await h.seedDevice(seed);
  expect((await push(a, [a.builder.genesis()]))[0]?.status).toBe('accepted');
  const storeB = await h.seedStore(a.world.tenantId, seed + 500_000);
  const b = await h.seedDeviceIn(a.world.tenantId, storeB, seed + 1);
  expect((await push(b, [b.builder.genesis()]))[0]?.status).toBe('accepted');

  const item = a.builder.append({
    type: 'inventory.item_added',
    entityType: 'inventory_item',
    storeId: null,
    payload: {
      name: 'LCD Redmi Note 10',
      nameAuto: false,
      code: null,
      barcode: null,
      categoryId: null,
      values: {},
      tags: [],
      fits: [],
    },
  });
  const count = a.builder.append({
    type: 'inventory.stock_counted',
    entityType: 'inventory_movement',
    payload: { itemId: item.entityId, counted: 10, expected: 0, note: null },
  });
  const results = await push(a, [item, count]);
  expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  return { a, b, storeB, itemId: item.entityId };
}

function send(
  builder: ChainBuilder,
  world: ChainWorld,
  toStoreId: string,
  itemId: string,
  movedQty = 4,
  movedTo = toStoreId,
) {
  const transferNumber = `TR-${formatTicketNumber(world.deviceId, 1)}`;
  const sent = builder.append({
    type: 'inventory.transfer_sent',
    entityType: 'inventory_transfer',
    payload: {
      transferNumber,
      toStoreId,
      note: null,
      lines: [{ itemId, name: 'LCD Redmi Note 10', qty: 4 }],
    },
  });
  const movement = builder.append({
    type: 'inventory.stock_sent',
    entityType: 'inventory_movement',
    payload: {
      itemId,
      qty: movedQty,
      sink: { kind: 'transfer', id: sent.entityId, label: transferNumber, toStoreId: movedTo },
    },
  });
  return { sent, movement, transferNumber };
}

describe('a transfer reaches both stores, and only the transfer', () => {
  test('provenance — the DB that answered (T-14d)', () => {
    expect(h.provenance).not.toBe('');
  });

  test('B pulls the transfer and the stock that left for it, not A’s count; A pulls the arrival', async () => {
    const { a, b, storeB, itemId } = await twoStores(7401);
    const { sent, movement, transferNumber } = send(a.builder, a.world, storeB, itemId);
    expect((await push(a, [sent, movement])).map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    const stored = await h.db
      .selectFrom('operations')
      .select(['id', 'otherStoreId'])
      .where('id', 'in', [sent.id, movement.id])
      .execute();
    expect(new Map(stored.map((row) => [row.id, row.otherStoreId]))).toEqual(
      new Map([
        [sent.id, storeB],
        [movement.id, storeB],
      ]),
    );

    const atB = await pulledTypes(b.auth);
    expect(atB).toContain('inventory.transfer_sent');
    expect(atB).toContain('inventory.item_added');
    expect(atB).toContain('inventory.stock_sent');
    expect(atB).not.toContain('inventory.stock_counted');

    const arrival = b.builder.append({
      type: 'inventory.transfer_received',
      entityType: 'inventory_transfer_arrival',
      payload: {
        transferId: sent.entityId,
        fromStoreId: a.world.storeId,
        note: null,
        lines: [{ itemId, qty: 3 }],
      },
    });
    const inStock = b.builder.append({
      type: 'inventory.stock_received',
      entityType: 'inventory_movement',
      payload: {
        itemId,
        qty: 3,
        source: { kind: 'transfer_arrival', id: arrival.entityId, label: transferNumber },
      },
    });
    expect((await push(b, [arrival, inStock])).map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    const atA = await pulledTypes(a.auth);
    expect(atA).toContain('inventory.transfer_received');
    expect(atA).not.toContain('inventory.stock_received');

    // The server's own records: A's stock left, B's came in, and 1 is still on its way.
    const moves = await h.db
      .selectFrom('inventoryMovements')
      .select(['storeId', 'qty'])
      .where('itemId', '=', itemId)
      .where('kind', '<>', 'counted')
      .execute();
    expect(moves).toEqual(
      expect.arrayContaining([
        { storeId: a.world.storeId, qty: -4 },
        { storeId: storeB, qty: 3 },
      ]),
    );
  });

  test('B cannot receive more than was sent, even pushed straight to the server', async () => {
    const { a, b, storeB, itemId } = await twoStores(7402);
    const { sent, movement } = send(a.builder, a.world, storeB, itemId);
    await push(a, [sent, movement]);
    const arrival = b.builder.append({
      type: 'inventory.transfer_received',
      entityType: 'inventory_transfer_arrival',
      payload: {
        transferId: sent.entityId,
        fromStoreId: a.world.storeId,
        note: null,
        lines: [{ itemId, qty: 9 }],
      },
    });
    const [result] = await push(b, [arrival]);
    expect(result).toMatchObject({ status: 'rejected', code: 'RULE_VIOLATED' });
  });

  test('B cannot receive a transfer whose stock never left A (sent without its movement)', async () => {
    const { a, b, storeB, itemId } = await twoStores(7404);
    const { sent } = send(a.builder, a.world, storeB, itemId);
    expect((await push(a, [sent]))[0]?.status).toBe('accepted');
    const arrival = b.builder.append({
      type: 'inventory.transfer_received',
      entityType: 'inventory_transfer_arrival',
      payload: {
        transferId: sent.entityId,
        fromStoreId: a.world.storeId,
        note: null,
        lines: [{ itemId, qty: 1 }],
      },
    });
    const [result] = await push(b, [arrival]);
    expect(result).toMatchObject({ status: 'rejected', code: 'RULE_VIOLATED' });
  });

  test('a stock movement naming another store than its transfer is refused', async () => {
    const { a, storeB, itemId } = await twoStores(7405);
    const storeC = await h.seedStore(a.world.tenantId, 7405 + 600_000);
    const { sent, movement } = send(a.builder, a.world, storeB, itemId, 4, storeC);
    const results = await push(a, [sent, movement]);
    expect(results[0]?.status).toBe('accepted');
    expect(results[1]).toMatchObject({ status: 'rejected', code: 'RULE_VIOLATED' });
  });

  test('a stock movement that does not match its transfer is refused', async () => {
    const { a, storeB, itemId } = await twoStores(7403);
    const { sent, movement: wrong } = send(a.builder, a.world, storeB, itemId, 1);
    const results = await push(a, [sent, wrong]);
    expect(results[0]?.status).toBe('accepted');
    expect(results[1]).toMatchObject({ status: 'rejected', code: 'RULE_VIOLATED' });
  });
});

describe('the second store is checked, not taken on the phone’s word', () => {
  test.each([
    ['its own store', (world: ChainWorld) => world.storeId],
    ['a store of no business here', () => '01920000-0000-7000-8000-00000000dead'],
  ])('a transfer naming %s → SCOPE_VIOLATION, not logged', async (_label, target) => {
    const { a, itemId } = await twoStores(7411);
    const { sent } = send(a.builder, a.world, target(a.world), itemId);
    const [result] = await push(a, [sent]);
    expect(result).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
    const logged = await h.db
      .selectFrom('operations')
      .select('id')
      .where('id', '=', sent.id)
      .execute();
    expect(logged).toHaveLength(0);
  });

  test('a store of ANOTHER business → SCOPE_VIOLATION', async () => {
    const { a, itemId } = await twoStores(7412);
    const other = await h.seedDevice(7499);
    const { sent } = send(a.builder, a.world, other.world.storeId, itemId);
    const [result] = await push(a, [sent]);
    expect(result).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });
});
