// A new device catching up on a store's history, for the benchmarks: the device composed the way
// `apps/mobile` bootstrap composes it (file-backed SQLite with the production pragmas and at-rest
// column cipher, client migrations, projection engine, search cache), and an in-memory server that
// pages a fixed op stream the way the real cursor pull does.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  createProjectionEngine,
  registerModules,
  SearchIndexCache,
  type AnyModuleDefinition,
  type CryptoPort,
  type SyncTransportPort,
} from '@bolusi/core';
import { openClientDb, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import type { DeviceInfo, PullRequest, PullResponse, SignedOperation } from '@bolusi/schemas';
import { openFileDriver } from '@bolusi/sqlite-test-driver';
import { noblePort, nodeColumnAead } from '@bolusi/test-support';

import { repairModule } from '../src/repair/index.js';

const DEVICES_DIRECTORY_VERSION = 1;

/** RFC 8410 SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Phones verify through OpenSSL (react-native-quick-crypto), not the pure-JS noble port the tests
 * use, so the device pulls with node:crypto's OpenSSL for the two calls the pull makes per op.
 */
export const opensslPort: CryptoPort = {
  ...noblePort,
  sha256: (data) => new Uint8Array(createHash('sha256').update(data).digest()),
  verify(signature, message, publicKey) {
    try {
      const key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
        format: 'der',
        type: 'spki',
      });
      return verify(null, message, key, signature);
    } catch {
      return false;
    }
  },
};

/** Serves a fixed op stream page by page, the way the server's cursor pull does. */
export class ReplayTransport implements SyncTransportPort {
  wireBytes = 0;
  gzipBytes = 0;

  constructor(
    private readonly ops: readonly SignedOperation[],
    private readonly devices: readonly DeviceInfo[],
  ) {}

  push(): never {
    throw new Error('the replay server only serves pulls');
  }

  pull(request: PullRequest): Promise<PullResponse> {
    const page = this.ops.slice(request.cursor, request.cursor + request.limit);
    const nextCursor = request.cursor + page.length;
    const response: PullResponse = {
      ops: [...page],
      nextCursor,
      hasMore: nextCursor < this.ops.length,
      serverTime: Date.now(),
      ...(request.devicesDirectoryVersion === DEVICES_DIRECTORY_VERSION
        ? {}
        : { devices: [...this.devices], devicesDirectoryVersion: DEVICES_DIRECTORY_VERSION }),
    };
    const body = Buffer.from(JSON.stringify(response));
    this.wireBytes += body.length;
    this.gzipBytes += gzipSync(body).length;
    // Round-trip through JSON, as a real response body would be.
    return Promise.resolve(JSON.parse(body.toString()) as PullResponse);
  }
}

export async function openFreshDevice(directory: string) {
  const conn = await openClientDb({
    driverFactory: ({ name, location }) =>
      Promise.resolve(openFileDriver(join(location ?? '', name))),
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('ab'.repeat(32)) },
    aead: nodeColumnAead,
    location: directory,
  });
  await runClientMigrations(conn.driver, { now: () => Date.now() });
  const registry = registerModules([
    repairModule as unknown as AnyModuleDefinition<ClientDatabase>,
  ]);
  const engine = createProjectionEngine(conn.db, registry.projections);
  const search = new SearchIndexCache(engine.invalidation);
  return { conn, engine, search };
}
