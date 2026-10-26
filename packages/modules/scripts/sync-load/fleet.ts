// The simulated fleet: tenants, stores and devices seeded straight into a disposable database, and a
// stream of realistic signed repair changes for every writing device.
//
// Changes come from one store history written through the real repair commands (`store-history.ts`),
// then re-keyed per device: every id is swapped for the device's own tenant, store, staff and fresh
// entity ids, and the chain is re-signed with the device's key and today's clock. The server sees
// exactly what a phone would send, without running a phone runtime per simulated device.
import { createHash } from 'node:crypto';

import {
  bytesToBase64,
  canonicalizeJcs,
  createUuidV7Generator,
  signOp,
  type JsonValue,
} from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH, type SignedCore, type SignedOperation } from '@bolusi/schemas';
import { connectRawSql, type RawSqlConnection } from '@bolusi/db-server/testing';
import { opensslPort, toSignedCore } from '@bolusi/test-support';

import { writeStoreHistory } from '../store-history.js';

export interface FleetShape {
  readonly tenants: number;
  readonly storesPerTenant: number;
  /** Devices that write changes (the counter PC and the technicians' phones). */
  readonly writersPerStore: number;
  /** Devices that only follow along (the owner's phone, a spare counter phone). */
  readonly readersPerStore: number;
}

export interface SimIdentity {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly secretKey: Uint8Array;
  readonly publicKeyB64: string;
  readonly cashierId: string;
  readonly technicianId: string;
  readonly writer: boolean;
  /** Index of the store across the whole fleet (for grouping results per store). */
  readonly storeIndex: number;
}

const newId = createUuidV7Generator({
  now: () => Date.now(),
  randomBytes: (n) => opensslPort.randomBytes(n),
});

function deviceKey(index: number): { secretKey: Uint8Array; publicKeyB64: string } {
  const secretKey = new Uint8Array(
    createHash('sha256').update(`sync-load-device-${index}`).digest(),
  );
  return {
    secretKey,
    publicKeyB64: bytesToBase64(opensslPort.ed25519GetPublicKey(secretKey)),
  };
}

/** Lay out ids for the whole fleet. Writers come first in each store. */
export function planFleet(shape: FleetShape, firstDevice = 0): SimIdentity[] {
  const devices: SimIdentity[] = [];
  let deviceIndex = firstDevice;
  let storeIndex = 0;
  for (let t = 0; t < shape.tenants; t += 1) {
    const tenantId = newId();
    for (let s = 0; s < shape.storesPerTenant; s += 1) {
      const storeId = newId();
      const cashierId = newId();
      const technicianId = newId();
      for (let d = 0; d < shape.writersPerStore + shape.readersPerStore; d += 1) {
        devices.push({
          tenantId,
          storeId,
          deviceId: newId(),
          token: `bdt_load${deviceIndex.toString(16).padStart(28, '0')}`,
          ...deviceKey(deviceIndex),
          cashierId,
          technicianId,
          writer: d < shape.writersPerStore,
          storeIndex,
        });
        deviceIndex += 1;
      }
      storeIndex += 1;
    }
  }
  return devices;
}

/** More devices for an existing store, e.g. new phones that will do their first sync. */
export function addDevices(like: SimIdentity, count: number, firstDevice: number): SimIdentity[] {
  return Array.from({ length: count }, (_, i) => ({
    ...like,
    deviceId: newId(),
    token: `bdt_load${(firstDevice + i).toString(16).padStart(28, '0')}`,
    ...deviceKey(firstDevice + i),
    writer: false,
  }));
}

/** Insert many rows with one statement per chunk. Column names are trusted constants. */
async function insertRows(
  client: RawSqlConnection,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += 1000) {
    const chunk = rows.slice(start, start + 1000);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const slots = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${slots.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

/**
 * Seed the directory rows the server needs for these devices: tenants, stores, the two staff per store
 * (with every permission, at their store), and the enrolled devices with their token hashes. The
 * connection must be the database owner, which bypasses row security for seeding.
 */
export async function seedFleet(ownerUrl: string, devices: readonly SimIdentity[]): Promise<void> {
  const client = await connectRawSql(ownerUrl);
  try {
    const at = Date.now();
    const tenants = [...new Set(devices.map((d) => d.tenantId))];
    const stores = [...new Map(devices.map((d) => [d.storeId, d])).values()];
    const roleOf = new Map(tenants.map((tenantId) => [tenantId, newId()]));
    const permissions = await client.query<{ id: string }>('SELECT id FROM permissions');

    await insertRows(
      client,
      'tenants',
      ['id', 'name', 'created_at'],
      tenants.map((id, i) => [id, `Load tenant ${i + 1}`, at]),
    );
    await insertRows(
      client,
      'tenant_op_counters',
      ['tenant_id', 'next_server_seq'],
      tenants.map((id) => [id, 1]),
    );
    await insertRows(
      client,
      'roles',
      ['id', 'tenant_id', 'name', 'scope_type', 'created_at'],
      tenants.map((id) => [roleOf.get(id), id, 'load_staff', 'store', at]),
    );
    await insertRows(
      client,
      'role_permissions',
      ['role_id', 'tenant_id', 'permission_id'],
      tenants.flatMap((id) => permissions.map((p) => [roleOf.get(id), id, p.id])),
    );
    await insertRows(
      client,
      'stores',
      ['id', 'tenant_id', 'name', 'created_at'],
      stores.map((d) => [d.storeId, d.tenantId, `Store ${d.storeIndex + 1}`, at]),
    );
    const staff = stores.flatMap(
      (d) =>
        [
          [d.cashierId, d, 'Kasir'],
          [d.technicianId, d, 'Teknisi'],
        ] as const,
    );
    await insertRows(
      client,
      'users',
      ['id', 'tenant_id', 'name', 'created_at'],
      staff.map(([id, d, name]) => [id, d.tenantId, `${name} ${d.storeIndex + 1}`, at]),
    );
    await insertRows(
      client,
      'user_stores',
      ['user_id', 'tenant_id', 'store_id'],
      staff.map(([id, d]) => [id, d.tenantId, d.storeId]),
    );
    await insertRows(
      client,
      'user_roles',
      ['user_id', 'tenant_id', 'role_id', 'store_id'],
      staff.map(([id, d]) => [id, d.tenantId, roleOf.get(d.tenantId), d.storeId]),
    );
    await insertRows(
      client,
      'devices',
      ['id', 'tenant_id', 'store_id', 'signing_key_public', 'token_hash', 'enrolled_at'],
      devices.map((d) => [
        d.deviceId,
        d.tenantId,
        d.storeId,
        d.publicKeyB64,
        createHash('sha256').update(d.token).digest('hex'),
        at,
      ]),
    );
  } finally {
    await client.close();
  }
}

/** One store's history, ready to be re-keyed onto any writing device. */
export interface ChangeTemplate {
  /** Canonical signed-core text of each template op, genesis first. */
  readonly cores: readonly string[];
  /** Index (into `cores`) where each user action starts; the genesis is not an action. */
  readonly actionStarts: readonly number[];
  readonly ticketsPerAction: number;
  readonly fixed: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly deviceId: string;
    /** Counter-side authors (the cashier and the owners); all become the store's cashier. */
    readonly cashierIds: readonly string[];
    readonly technicianIds: readonly string[];
  };
}

export async function buildTemplate(days: number, ticketsPerDay: number): Promise<ChangeTemplate> {
  const history = await writeStoreHistory({ days, ticketsPerDay, seed: 7 });
  const w = history.writer;
  const cores = history.ops.map((op) => canonicalizeJcs(toSignedCore(op) as unknown as JsonValue));
  // A user action is one command; its changes share an entity, so a new entity starts a new action.
  const actionStarts: number[] = [];
  for (let i = 1; i < history.ops.length; i += 1) {
    if (i === 1 || history.ops[i]!.entityId !== history.ops[i - 1]!.entityId) actionStarts.push(i);
  }
  await w.close();
  return {
    cores,
    actionStarts,
    ticketsPerAction: history.tickets / actionStarts.length,
    fixed: {
      tenantId: w.tenantId,
      storeId: w.storeId,
      deviceId: w.deviceId,
      cashierIds: [w.cashierId, w.ownerId, w.storeOwnerId],
      technicianIds: [w.technicianId, w.technician2Id, w.zeroUserId],
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The endless, correctly chained change stream of one writing device. */
export class ChangeStream {
  #seq = 0;
  #previousHash: string = GENESIS_PREVIOUS_HASH;
  #action = 0;
  #ids = new Map<string, string>();
  readonly #fixed: Map<string, string>;

  constructor(
    private readonly template: ChangeTemplate,
    private readonly device: SimIdentity,
  ) {
    const { fixed } = template;
    this.#fixed = new Map([
      [fixed.tenantId, device.tenantId],
      [fixed.storeId, device.storeId],
      [fixed.deviceId, device.deviceId],
      ...fixed.cashierIds.map((id) => [id, device.cashierId] as const),
      ...fixed.technicianIds.map((id) => [id, device.technicianId] as const),
    ]);
  }

  /** The changes of the next user action (the genesis rides along with the very first one). */
  nextAction(): SignedOperation[] {
    const { cores, actionStarts } = this.template;
    if (this.#action === actionStarts.length) {
      // Template exhausted: replay it as new tickets with fresh ids, without a second genesis.
      this.#action = 0;
      this.#ids = new Map();
    }
    const start = this.#seq === 0 ? 0 : actionStarts[this.#action]!;
    const end = actionStarts[this.#action + 1] ?? cores.length;
    this.#action += 1;
    const ops: SignedOperation[] = [];
    for (let i = start; i < end; i += 1) ops.push(this.#sign(cores[i]!));
    return ops;
  }

  /** At least `count` changes, whole actions only. */
  next(count: number): SignedOperation[] {
    const ops: SignedOperation[] = [];
    while (ops.length < count) ops.push(...this.nextAction());
    return ops;
  }

  #sign(templateCore: string): SignedOperation {
    const text = templateCore.replace(UUID, (id) => {
      const fixed = this.#fixed.get(id);
      if (fixed !== undefined) return fixed;
      let fresh = this.#ids.get(id);
      if (fresh === undefined) {
        fresh = newId();
        this.#ids.set(id, fresh);
      }
      return fresh;
    });
    const core = JSON.parse(text) as SignedCore & { seq: number };
    if (core.type === 'auth.device_enrolled') {
      // The repair harness's genesis is test-local; a real enrollment carries the device's details.
      core.payload = {
        storeId: this.device.storeId,
        deviceName: 'Load test device',
        devicePublicKeyB64: this.device.publicKeyB64,
      };
    }
    this.#seq += 1;
    const signed = signOp(
      { ...core, seq: this.#seq, previousHash: this.#previousHash, timestamp: Date.now() },
      this.device.secretKey,
      opensslPort,
    );
    this.#previousHash = signed.hash;
    return signed;
  }
}
