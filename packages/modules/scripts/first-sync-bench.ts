// First-sync benchmark: how long a brand-new device takes to pull a store's whole history.
//
//   pnpm --filter @bolusi/modules bench:first-sync            # one year, 50 tickets a day
//   DAYS=30 TICKETS_PER_DAY=50 pnpm --filter @bolusi/modules bench:first-sync
//
// The history is written through the real repair commands. The new device is composed the way
// `apps/mobile` bootstrap composes it (file-backed SQLite with the production pragmas and at-rest
// column cipher, client migrations, projection engine, search cache) and pulls through the real
// `runPullPhase`: per-op signature verification, encrypted insert and projection, one transaction per
// 500-op batch. Only the server is replaced, by an in-memory pager over the same op stream, so the
// numbers are client cost. Wire size is reported so download time can be estimated separately.
//
// These are Node numbers on the machine that runs the script, not phone numbers.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  createProjectionEngine,
  registerModules,
  runPullPhase,
  SearchIndexCache,
  type AnyModuleDefinition,
  type CryptoPort,
  type SyncTransportPort,
} from '@bolusi/core';
import { openClientDb, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import {
  MAX_PULL_LIMIT,
  type DeviceInfo,
  type PullRequest,
  type PullResponse,
  type SignedOperation,
} from '@bolusi/schemas';
import { openFileDriver } from '@bolusi/sqlite-test-driver';
import { noblePort, nodeColumnAead } from '@bolusi/test-support';
import { SILENT_SURFACE } from '@bolusi/test-support/chaos';

import { customerSearchSource, repairModule, ticketSearchSource } from '../src/repair/index.js';
import { writeStoreHistory } from './store-history.js';

const DEVICES_DIRECTORY_VERSION = 1;

/** RFC 8410 SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Phones verify through OpenSSL (react-native-quick-crypto), not the pure-JS noble port the tests
 * use, so the device pulls with node:crypto's OpenSSL for the two calls the pull makes per op.
 */
const opensslPort: CryptoPort = {
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
class ReplayTransport implements SyncTransportPort {
  wireBytes = 0;
  gzipBytes = 0;

  constructor(
    private readonly ops: readonly SignedOperation[],
    private readonly devices: readonly DeviceInfo[],
  ) {}

  push(): never {
    throw new Error('the first-sync benchmark only pulls');
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

async function openFreshDevice(directory: string) {
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

/**
 * `PROFILE=out.cpuprofile` writes a V8 CPU profile of one phase: the pull by default, or the
 * rebuild with `PROFILE_PHASE=rebuild`. Open it in Chrome DevTools or speedscope.
 */
async function startProfiler(phase: 'pull' | 'rebuild'): Promise<Session | null> {
  if (!process.env['PROFILE'] || (process.env['PROFILE_PHASE'] ?? 'pull') !== phase) return null;
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.start');
  return session;
}

async function stopProfiler(session: Session | null): Promise<void> {
  if (session === null) return;
  const { profile } = await session.post('Profiler.stop');
  writeFileSync(process.env['PROFILE']!, JSON.stringify(profile));
  session.disconnect();
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

async function main(): Promise<void> {
  const days = Number(process.env['DAYS'] ?? 365);
  const ticketsPerDay = Number(process.env['TICKETS_PER_DAY'] ?? 50);

  let started = performance.now();
  const history = await writeStoreHistory({
    days,
    ticketsPerDay,
    seed: 1,
    onDay: (day) => {
      if (day % 30 === 0) process.stderr.write(`  wrote day ${day}/${days}\n`);
    },
  });
  const writeMs = performance.now() - started;
  const { ops, writer } = history;

  const transport = new ReplayTransport(ops, [
    {
      id: writer.deviceId,
      storeId: writer.storeId,
      kind: 'member',
      signingKeyPublic: writer.signingKeyPublic,
      status: 'active',
      revokedAt: null,
    },
  ]);
  const directory = mkdtempSync(join(tmpdir(), 'bolusi-first-sync-'));
  const device = await openFreshDevice(directory);

  try {
    let profiler = await startProfiler('pull');
    started = performance.now();
    const result = await runPullPhase({
      db: device.conn.db,
      transaction: (fn) => device.conn.transaction(() => fn()),
      transport,
      surface: SILENT_SURFACE,
      crypto: opensslPort,
      clock: { now: () => Date.now() },
      applyPulledOp: (op) => device.engine.applyPulledOp(op),
      limit: MAX_PULL_LIMIT,
    });
    const pullMs = performance.now() - started;
    await stopProfiler(profiler);
    if (result.applied !== ops.length || result.quarantined !== 0) {
      throw new Error(
        `applied ${result.applied} of ${ops.length}, quarantined ${result.quarantined}`,
      );
    }

    const scope = { tenantId: writer.tenantId, storeId: writer.storeId };
    started = performance.now();
    const ticketIndex = await device.search.index(ticketSearchSource, device.conn.db, scope);
    await device.search.index(customerSearchSource, device.conn.db, scope);
    const indexMs = performance.now() - started;
    started = performance.now();
    const hits = ticketIndex.search('yohanis wnda a14', 20);
    const searchMs = performance.now() - started;

    await device.conn.driver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = statSync(join(directory, 'bolusi.db')).size;
    // Where the bytes are: the five largest tables and indexes (SQLite's dbstat virtual table).
    const largest = await device.conn.driver.execute(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 5`,
    );
    const breakdown = largest.rows
      .map((row) => `${String(row['name'])} ${megabytes(Number(row['bytes']))}`)
      .join(', ');

    // A full re-fold from the op log: what a module version bump costs on this device.
    profiler = await startProfiler('rebuild');
    started = performance.now();
    await device.engine.rebuild(repairModule.id);
    const rebuildMs = performance.now() - started;
    await stopProfiler(profiler);

    const report = [
      `History: ${days} days × ${ticketsPerDay} tickets = ${history.tickets} tickets, ${ops.length} ops (${(ops.length / history.tickets).toFixed(1)} per ticket), written in ${seconds(writeMs)}`,
      `Wire: ${megabytes(transport.wireBytes)} JSON, ${megabytes(transport.gzipBytes)} gzipped, ${result.batches} pages`,
      `Pull + verify + apply: ${seconds(pullMs)} (${((pullMs / ops.length) * 1000).toFixed(0)} µs per op, ${Math.round(ops.length / (pullMs / 1000))} ops/s)`,
      `Search index build after sync: ${seconds(indexMs)}; one fuzzy query: ${searchMs.toFixed(1)} ms (${hits.length} hits)`,
      `Device database: ${megabytes(dbBytes)} (largest: ${breakdown})`,
      `Repair projection rebuild from the op log: ${seconds(rebuildMs)}`,
    ];
    process.stdout.write(`${report.join('\n')}\n`);
  } finally {
    await device.conn.close();
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
