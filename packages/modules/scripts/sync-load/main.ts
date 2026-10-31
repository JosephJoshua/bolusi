// Sync load test: the real server process on a real PostgreSQL database, driven by a fleet of
// simulated store devices that follow the app's sync rules (see device.ts).
//
//   DATABASE_URL="$(pnpm -s db:url)" pnpm --filter @bolusi/modules bench:sync-load
//   SCALE=x10 SCENARIOS=steady,outage DATABASE_URL=... pnpm --filter @bolusi/modules bench:sync-load
//
// SCALE: pilot (1 tenant, 10 stores), x10 (1 tenant, 100 stores), x100 (100 tenants of 10 stores).
// Each store has WRITERS (default 2) devices making repair changes and READERS (default 2) following.
// SCENARIOS (default all, in this order):
//   steady      a busy hour (TICKETS_PER_HOUR per store, default 15) for DURATION_S (default 120)
//   burst       every writer makes BURST_ACTIONS (default 10) changes at the same moment
//   outage      every device offline while the stores keep working for OUTAGE_MIN (default 120)
//               minutes, then all reconnect within a few seconds, as after a server restart
//   first-sync  NEW_DEVICES (default 3) new phones in store 1 pull HISTORY_DAYS (default 90) of that
//               store's history while the busy hour continues; APPLY_MS (default 1.5) per change is
//               the phone's own work between pages
//
// It needs the built server (`pnpm exec tsc -b`) and creates, migrates and drops a database named
// `bolusi_load` on the DATABASE_URL cluster, which must be on this machine. SERVER_CPUS / LOAD_CPUS
// pin the server and this generator with `taskset`. PG_CONTAINER names the Docker container whose CPU
// is reported (default: this worktree's compose Postgres). With pg_stat_statements preloaded on that
// server, the most expensive statements are listed per phase. SERVER_ENTRY points at another
// checkout's built server (e.g. a worktree of main) to compare before and after; the database is
// migrated from that checkout. BUNDLE_INTERVAL_S overrides the devices' bundle refresh throttle (0
// refreshes every cycle, as clients did before the throttle).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE_REFRESH_INTERVAL_MS } from '@bolusi/core';
import { connectRawSql } from '@bolusi/db-server/testing';

import { SimDevice } from './device.js';
import {
  addDevices,
  buildTemplate,
  ChangeStream,
  planFleet,
  seedFleet,
  type FleetShape,
  type SimIdentity,
} from './fleet.js';
import { PhaseResources, Recorder, type ResourceProbe } from './metrics.js';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const num = (name: string, fallback: number): number => Number(env(name, String(fallback)));

const SCALES: Record<string, Pick<FleetShape, 'tenants' | 'storesPerTenant'>> = {
  pilot: { tenants: 1, storesPerTenant: 10 },
  x10: { tenants: 1, storesPerTenant: 100 },
  x100: { tenants: 100, storesPerTenant: 10 },
};
const scaleName = env('SCALE', 'pilot');
const scale = SCALES[scaleName];
if (scale === undefined) throw new Error(`SCALE must be one of ${Object.keys(SCALES).join(', ')}`);
const shape: FleetShape = {
  tenants: num('TENANTS', scale.tenants),
  storesPerTenant: num('STORES_PER_TENANT', scale.storesPerTenant),
  writersPerStore: num('WRITERS', 2),
  readersPerStore: num('READERS', 2),
};
const scenarios = env('SCENARIOS', 'steady,burst,outage,first-sync').split(',');
const ticketsPerHour = num('TICKETS_PER_HOUR', 15);
const port = num('PORT', 3999);
const baseUrl = `http://127.0.0.1:${port}`;
const ownerUrl = process.env['DATABASE_URL'];
if (ownerUrl === undefined)
  throw new Error('set DATABASE_URL to the local dev cluster (pnpm -s db:url)');

const serverEntry = fileURLToPath(
  new URL(env('SERVER_ENTRY', '../../../../apps/server/dist/main.js'), import.meta.url),
);

const LOAD_DB = 'bolusi_load';
const APP_PASSWORD = 'bolusi_app_load';

function withDatabase(url: string, database: string, user?: string): string {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`refusing to load-test a non-local database (${parsed.hostname})`);
  }
  const credentials =
    user === undefined ? `${parsed.username}:${parsed.password}` : `${user}:${APP_PASSWORD}`;
  return `postgres://${credentials}@${parsed.host}/${database}`;
}

const log = (line = ''): void => void process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepareDatabase(): Promise<void> {
  const admin = await connectRawSql(withDatabase(ownerUrl!, 'postgres'));
  await admin.query(`DROP DATABASE IF EXISTS ${LOAD_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${LOAD_DB}`);
  await admin.close();
  // Migrate with the checkout the server comes from, so a baseline server gets its own schema.
  execFileSync('pnpm', ['--filter', '@bolusi/db-server', 'db:migrate'], {
    cwd: resolve(dirname(serverEntry), '../../..'),
    env: { ...process.env, DATABASE_URL: withDatabase(ownerUrl!, LOAD_DB) },
    stdio: 'ignore',
  });
  const owner = await connectRawSql(withDatabase(ownerUrl!, LOAD_DB));
  // The server connects as the row-security-bound app role, as in production.
  await owner.query(`ALTER ROLE bolusi_app PASSWORD '${APP_PASSWORD}'`);
  await owner.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements').catch(() => undefined);
  await owner.close();
}

function pinned(cpus: string | undefined, command: string, args: string[]): [string, string[]] {
  return cpus === undefined ? [command, args] : ['taskset', ['-c', cpus, command, ...args]];
}

async function startServer(): Promise<ChildProcess> {
  const [command, args] = pinned(process.env['SERVER_CPUS'], process.execPath, [serverEntry]);
  const child = spawn(command, args, {
    env: {
      ...process.env,
      DATABASE_URL: withDatabase(ownerUrl!, LOAD_DB, 'bolusi_app'),
      PORT: String(port),
      // Required at boot; no simulated device registers a push token, so nothing is ever sent.
      EXPO_ACCESS_TOKEN: 'load-test-not-used',
      MEDIA_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'bolusi-load-media-')),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited (${code})`)));
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) resolve();
    });
  });
  return child;
}

function composePostgres(): string | null {
  if (process.env['PG_CONTAINER'] !== undefined) return process.env['PG_CONTAINER'];
  try {
    const id = execFileSync('docker', ['compose', 'ps', '-q', 'postgres'], { encoding: 'utf8' });
    return id.trim() === '' ? null : id.trim();
  } catch {
    return null;
  }
}

/** Each writer acts at random (Poisson) at the store's ticket rate until stopped. */
function startActivity(
  writers: readonly SimDevice[],
  streams: Map<SimDevice, ChangeStream>,
  ticketsPerAction: number,
) {
  const actionsPerSecond = ticketsPerHour / shape.writersPerStore / ticketsPerAction / 3600;
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const schedule = (device: SimDevice) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        if (stopped) return;
        device.append(streams.get(device)!.nextAction());
        schedule(device);
      },
      (-Math.log(1 - Math.random()) / actionsPerSecond) * 1000,
    );
    timers.add(timer);
  };
  writers.forEach(schedule);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
  };
}

async function main(): Promise<void> {
  const devices = planFleet(shape);
  const firstStoreWriter = devices[0]!;
  const newcomers = addDevices(firstStoreWriter, num('NEW_DEVICES', 3), devices.length);
  log(
    `Fleet ${scaleName}: ${shape.tenants} tenant(s) × ${shape.storesPerTenant} stores, ` +
      `${shape.writersPerStore + shape.readersPerStore} devices per store (${devices.length} devices)`,
  );

  await prepareDatabase();
  await seedFleet(withDatabase(ownerUrl!, LOAD_DB), [...devices, ...newcomers]);
  const template = await buildTemplate(num('TEMPLATE_DAYS', 10), 50);
  log(
    `Template: ${template.cores.length} changes, ${(1 / template.ticketsPerAction).toFixed(1)} actions per ticket`,
  );

  const server = await startServer();
  const probe: ResourceProbe = {
    serverPid: server.pid!,
    pgContainer: composePostgres(),
    ownerUrl: withDatabase(ownerUrl!, LOAD_DB),
  };

  let recorder = new Recorder();
  const byStore = new Map<string, SimDevice[]>();
  const onPulled = (device: SimDevice, op: { id: string; deviceId: string }) => {
    const acceptedAt = recorder.accepted.get(op.id);
    if (acceptedAt !== undefined && op.deviceId !== device.identity.deviceId) {
      recorder.propagation.push(Date.now() - acceptedAt);
    }
  };
  const makeDevice = (identity: SimIdentity, applyMsPerOp = 0) =>
    new SimDevice(identity, {
      baseUrl,
      recorder: () => recorder,
      onPulled,
      applyMsPerOp,
      bundleIntervalMs: num('BUNDLE_INTERVAL_S', BUNDLE_REFRESH_INTERVAL_MS / 1000) * 1000,
    });
  const fleet = devices.map((identity) => makeDevice(identity));
  for (const device of fleet) {
    const list = byStore.get(device.identity.storeId) ?? [];
    list.push(device);
    byStore.set(device.identity.storeId, list);
  }
  const writers = fleet.filter((d) => d.identity.writer);
  const streams = new Map(writers.map((d) => [d, new ChangeStream(template, d.identity)]));

  async function phase(title: string, body: () => Promise<string[] | void>): Promise<void> {
    log();
    log(`== ${title}`);
    recorder = new Recorder();
    const resources = new PhaseResources(probe);
    await resources.start();
    const extra = (await body()) ?? [];
    const { wallSeconds, lines } = await resources.stop();
    log(`  wall ${wallSeconds.toFixed(1)} s`);
    for (const line of [...extra, ...recorder.summary(wallSeconds), ...lines]) log(line);
  }

  const allIdle = async () => {
    const progress = setInterval(() => {
      const busy = fleet.filter((d) => d.busy);
      if (busy.length > 0) log(`  … ${busy.length} devices busy, e.g. ${busy[0]!.state}`);
    }, 10_000);
    await Promise.all(fleet.map((d) => d.idle()));
    clearInterval(progress);
  };

  try {
    // Warm-up, unmeasured: devices come online a few at a time and push their enrollment.
    for (const [i, device] of fleet.entries()) {
      if (device.identity.writer) device.append(streams.get(device)!.nextAction());
      device.connect();
      if (i % 50 === 49) await sleep(250);
    }
    await sleep(3000);
    await allIdle();

    if (scenarios.includes('steady')) {
      await phase(`steady busy hour for ${num('DURATION_S', 120)} s`, async () => {
        const before = new Map(fleet.map((d) => [d, d.bundleCalls]));
        const started = performance.now();
        const stop = startActivity(writers, streams, template.ticketsPerAction);
        await sleep(num('DURATION_S', 120) * 1000);
        stop();
        await allIdle();
        const hours = (performance.now() - started) / 3_600_000;
        const perHour = fleet
          .map((d) => (d.bundleCalls - before.get(d)!) / hours)
          .sort((a, b) => a - b);
        return [
          `  bundle refreshes per device, projected per hour: median ${perHour[Math.floor(perHour.length / 2)]!.toFixed(0)}, ` +
            `max ${perHour.at(-1)!.toFixed(0)} (the server allows 120 per device per hour)`,
        ];
      });
    }

    if (scenarios.includes('burst')) {
      await phase(
        `burst: every writer makes ${num('BURST_ACTIONS', 10)} actions at once`,
        async () => {
          const started = performance.now();
          for (const device of writers) {
            for (let i = 0; i < num('BURST_ACTIONS', 10); i += 1) {
              device.append(streams.get(device)!.nextAction());
            }
          }
          await sleep(APPEND_SETTLE_MS);
          await allIdle();
          return [
            `  every device settled after ${((performance.now() - started) / 1000).toFixed(1)} s`,
          ];
        },
      );
    }

    if (scenarios.includes('outage')) {
      const minutes = num('OUTAGE_MIN', 120);
      for (const device of fleet) device.disconnect();
      await sleep(500);
      const actionsPerWriter = Math.round(
        (ticketsPerHour / shape.writersPerStore / template.ticketsPerAction) * (minutes / 60),
      );
      for (const device of writers) {
        for (let i = 0; i < actionsPerWriter; i += 1)
          device.append(streams.get(device)!.nextAction());
      }
      await phase(
        `outage: ${minutes} min of offline work (${actionsPerWriter} actions per writer), then everyone reconnects`,
        async () => {
          const started = performance.now();
          const spread = num('RECONNECT_SPREAD_S', 5) * 1000;
          for (const device of fleet) setTimeout(() => device.connect(), Math.random() * spread);
          await sleep(spread + APPEND_SETTLE_MS);
          await allIdle();
          return [
            `  every device caught up after ${((performance.now() - started) / 1000).toFixed(1)} s`,
          ];
        },
      );
    }

    if (scenarios.includes('first-sync')) {
      const days = num('HISTORY_DAYS', 90);
      const storeWriters = byStore.get(firstStoreWriter.storeId)!.filter((d) => d.identity.writer);
      const historyActions = Math.round(
        (days * 50) / template.ticketsPerAction / storeWriters.length,
      );
      await phase(`history: store 1 uploads ${days} days at 50 tickets a day`, async () => {
        const started = performance.now();
        for (const device of storeWriters) {
          for (let i = 0; i < historyActions; i += 1)
            device.append(streams.get(device)!.nextAction());
        }
        await sleep(APPEND_SETTLE_MS);
        await allIdle();
        const seconds = (performance.now() - started) / 1000;
        return [`  ${recorder.opsPushed} changes uploaded in ${seconds.toFixed(1)} s`];
      });
      await phase(
        `first sync: ${newcomers.length} new phones in store 1 during the busy hour`,
        async () => {
          const stop = startActivity(writers, streams, template.ticketsPerAction);
          const phones = newcomers.map((identity) => makeDevice(identity, num('APPLY_MS', 1.5)));
          const started = performance.now();
          const done = await Promise.all(
            phones.map(async (phone) => {
              phone.connect();
              await sleep(APPEND_SETTLE_MS);
              await phone.idle();
              return (performance.now() - started) / 1000;
            }),
          );
          stop();
          for (const phone of phones) phone.disconnect();
          await allIdle();
          return [
            `  new phones caught up after ${done.map((s) => `${s.toFixed(0)} s`).join(', ')}`,
          ];
        },
      );
    }
  } finally {
    for (const device of fleet) device.disconnect();
    server.kill('SIGTERM');
  }
}

/** Long enough for a debounced push to have started. */
const APPEND_SETTLE_MS = 1_500;

await main();
process.exit(0);
