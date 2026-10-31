// @vitest-environment node
// One servisan from intake to handover across two devices, with the network dropping in between.
// Each device is the real offline core (the composition the PC runs; the phone builds the same
// parts from @bolusi/device) talking to the real server over a socket. The counter takes the phone
// in with photos and a DP, the technician's device starts and finishes the work offline with
// before/after photos and a price change the customer then agrees to at the counter, the counter
// goes through the handover checklist, takes the rest at pickup and closes the till. Along the way
// requests are cut off before they reach the server and after the server applied them. At the end
// every device and a newly registered one must hold the same servisan, its handover checklist and
// the same books, with nothing lost or doubled.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  provisionLaneOwner,
  startHarnessServer,
  type LaneCredentials,
  type RunningHarnessServer,
} from '@bolusi/harness';
import type { MediaRef, VideoRef } from '@bolusi/schemas';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { CoreState } from '../src/core/api.js';
import { connect, type Client } from '../src/main/rpc.js';
import type { Drop, JourneyDeviceData } from './journey-device.js';

/** A 4×4 JPEG: the core stores and uploads what the window already compressed. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCKiiiuM+LP/9k=',
  'base64',
);

interface Device {
  readonly name: string;
  readonly dataDir: string;
  readonly worker: Worker;
  readonly client: Client;
  state(): Promise<CoreState>;
  call<T = unknown>(method: string, ...args: readonly unknown[]): Promise<T>;
  setOnline(online: boolean): Promise<void>;
  /** Cut off the next request whose path matches. */
  dropNext(match: RegExp, how: Drop): Promise<void>;
  dropped(): Promise<string[]>;
}

let running: RunningHarnessServer;
let lane: LaneCredentials;
const devices: Device[] = [];

async function until<T>(
  read: () => T | Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

/** Start a device's core in its own worker over `dataDir` (new, or left by an earlier run). */
async function startDevice(name: string, dataDir: string, offline = false): Promise<Device> {
  // The worker loads the device's TypeScript through tsx, as the test runner does for this file.
  const entry = JSON.stringify(new URL('./journey-device.ts', import.meta.url).href);
  const worker = new Worker(
    `import('tsx/esm/api').then(({ register }) => { register(); return import(${entry}); })`,
    {
      eval: true,
      workerData: { dataDir, apiBaseUrl: running.url, offline } satisfies JourneyDeviceData,
    },
  );
  const client = connect({
    send: (message) => worker.postMessage(message),
    listen(onMessage) {
      worker.on('message', onMessage);
      return () => worker.off('message', onMessage);
    },
  });
  // A device that dies fails the test at once instead of leaving its calls hanging.
  worker.once('error', (error) => {
    console.error(`${name} stopped:`, error);
    client.close();
  });
  const call = <T>(method: string, ...args: readonly unknown[]) => client.call<T>(method, ...args);
  const device: Device = {
    name,
    dataDir,
    worker,
    client,
    call,
    state: () => call<CoreState>('test.state'),
    setOnline: (online) => call('test.setOnline', online),
    dropNext: (match, how) => call('test.dropNext', match, how),
    dropped: () => call<string[]>('test.dropped'),
  };
  devices.push(device);
  await call('test.start');
  return device;
}

/** A new device, registered to the store by the owner. */
async function openDevice(name: string): Promise<Device> {
  const device = await startDevice(name, mkdtempSync(join(tmpdir(), 'bolusi-journey-')));
  await device.call('enrollment.login', {
    loginIdentifier: lane.ownerLogin,
    password: lane.oneTimePassword,
  });
  await device.call('enrollment.enroll', { storeId: lane.storeId, deviceName: name });
  await device.call('enrollment.finish');
  await waitForPeople(device);
  return device;
}

async function waitForPeople(device: Device): Promise<void> {
  await until(
    async () => (await device.state()).session?.users ?? null,
    (users) => users !== null && users.length > 0,
    `${device.name} to list people`,
  );
}

/**
 * The power goes: the device stops with no chance to finish anything, then starts again, still
 * without a connection.
 */
async function powerCut(device: Device): Promise<Device> {
  device.client.close();
  await device.worker.terminate();
  devices.splice(devices.indexOf(device), 1);
  const restarted = await startDevice(device.name, device.dataDir, true);
  await waitForPeople(restarted);
  return restarted;
}

async function signIn(device: Device, userId: string, pin: string): Promise<void> {
  const outcome = await device.call('session.submitPin', userId, pin);
  expect(outcome).toMatchObject({ kind: 'opened' });
  await until(
    async () => (await device.state()).session,
    (s) => s?.active?.userId === userId && s.permissions.length > 0,
    `${device.name} to sign ${userId} in`,
  );
}

/** Sync now and wait until nothing is left to send (changes and photos) and a pull has run. */
async function settle(device: Device): Promise<void> {
  await device.call('test.requestSync');
  await until(
    async () => (await device.state()).sync,
    (sync) =>
      sync !== null &&
      sync.pendingOperationCount === 0 &&
      sync.pendingMediaCount === 0 &&
      sync.loopState === 'idle' &&
      !sync.manualSyncBusy,
    `${device.name} to finish syncing`,
    60_000,
  );
}

beforeAll(async () => {
  running = await startHarnessServer({ productionAuth: true, wallClock: true, port: 0 });
  lane = await provisionLaneOwner(running.server);
}, 120_000);

afterAll(async () => {
  for (const device of devices) {
    await device.call('test.stop').catch(() => undefined);
    device.client.close();
    await device.worker.terminate();
  }
  for (const dir of new Set(devices.map((device) => device.dataDir))) {
    rmSync(dir, { recursive: true, force: true });
  }
  await running?.close();
});

type Row = Record<string, unknown>;

/** Run a repair or money command on a device as the person signed in there. */
function act(device: Device, module: 'repair' | 'money') {
  return async (name: string, input: unknown): Promise<Row> => {
    const userId = (await device.state()).session?.active?.userId;
    if (userId === undefined) throw new Error(`nobody is signed in on ${device.name}`);
    return device.call<Row>(`${module}.run`, userId, name, input);
  };
}

async function read(device: Device, module: 'repair' | 'money', name: string, input: unknown) {
  const userId = (await device.state()).session!.active!.userId;
  const { rows } = await device.call<{ rows: Row[] }>(`${module}.query`, userId, name, input);
  return rows;
}

async function photo(device: Device): Promise<MediaRef> {
  const userId = (await device.state()).session!.active!.userId;
  const outcome = await device.call<{ kind: string; mediaRef: MediaRef }>(
    'media.importImage',
    userId,
    { bytes: new Uint8Array(JPEG), mime: 'image/jpeg' },
  );
  expect(outcome.kind).toBe('captured');
  return outcome.mediaRef;
}

/** The EBML header a WebM clip starts with, and a little after it: what the webcam recorder gives. */
const WEBM = new Uint8Array([
  0x1a,
  0x45,
  0xdf,
  0xa3,
  ...Array.from({ length: 2048 }, (_, i) => i % 251),
]);

async function video(device: Device): Promise<VideoRef> {
  const userId = (await device.state()).session!.active!.userId;
  const outcome = await device.call<{ kind: string; videoRef: VideoRef }>(
    'media.importVideo',
    userId,
    { bytes: new Uint8Array(WEBM), mime: 'video/webm' },
  );
  expect(outcome.kind).toBe('captured');
  return outcome.videoRef;
}

async function signature(device: Device): Promise<MediaRef> {
  const userId = (await device.state()).session!.active!.userId;
  const stroke = [
    { x: 20, y: 80 },
    { x: 120, y: 30 },
    { x: 220, y: 90 },
  ];
  const outcome = await device.call<{ kind: string; mediaRef: MediaRef }>(
    'media.captureSignature',
    userId,
    [stroke],
    { width: 300, height: 120 },
  );
  expect(outcome.kind).toBe('captured');
  return outcome.mediaRef;
}

async function switchTo(device: Device, userId: string, pin: string): Promise<void> {
  await device.call('session.lock');
  await signIn(device, userId, pin);
}

/** Nothing this device sent was refused or set aside by the server. */
async function expectNothingRefused(device: Device): Promise<void> {
  const sync = (await device.state()).sync!;
  expect({ device: device.name, rejected: sync.rejected, quarantined: sync.quarantined }).toEqual({
    device: device.name,
    rejected: [],
    quarantined: [],
  });
}

/** What the servisan's history keeps of its handover: the note and the checklist. */
function handoverEvent(ticket: Row): unknown {
  const events = ticket['events'] as { kind: string; detail: unknown }[];
  return events.find((event) => event.kind === 'repair.device_returned')?.detail;
}

/** Each handover checklist the server holds for a servisan. */
async function serverChecklists(ticketId: string): Promise<unknown[]> {
  const { rows } = await sql<{ checklist: unknown }>`
    SELECT payload->'checklist' AS checklist FROM operations
    WHERE tenant_id = ${lane.tenantId} AND type = 'repair.device_returned'
      AND entity_id = ${ticketId}
  `.execute(running.server.db);
  return rows.map((row) => row.checklist);
}

const CASHIER_PIN = '135790';
const TECH_PIN = '246813';
const DP = 100_000;
const INTAKE_TOTAL = 650_000;
const EXTRA = 150_000;
const GLASS = 50_000;
/** Checked with the customer at pickup, and the charger left at intake goes back. */
const HANDOVER_CHECKLIST = [
  { kind: 'check', item: 'customerTried', label: null, done: true },
  { kind: 'check', item: 'repairWorks', label: null, done: true },
  { kind: 'accessory', item: 'charger', label: null, done: true },
];

/** Every change of the journey, once each, however many times a send was retried. */
const EXPECTED_SERVER_OPS = {
  'money.cash_counted': 1,
  'money.charge_recorded': 1,
  // The DP and the rest at pickup.
  'money.payment_received': 2,
  'repair.customer_registered': 1,
  'repair.device_returned': 1,
  'repair.marked_repaired': 1,
  'repair.quote_change_proposed': 1,
  // The counter's screen protector and the technician's battery once the customer agreed.
  'repair.quote_changed': 2,
  'repair.status_link_made': 1,
  'repair.ticket_claimed': 1,
  'repair.ticket_opened': 1,
  'repair.ticket_repair_types_changed': 1,
  // Before and after.
  'repair.work_photos_added': 2,
  'repair.work_started': 1,
};

// The tests run in order over one store: the second picks up the devices and staff of the first.
describe('one servisan from intake to handover, offline in between', () => {
  let counter: Device;
  let bench: Device;
  let owner: string;
  let cashier: string;
  let technician: string;

  test('nothing is lost, doubled or out of balance', async () => {
    // ── The owner registers the counter PC and adds a cashier and a technician ───────────────
    counter = await openDevice('PC Kasir');
    owner = lane.ownerUserId;
    await signIn(counter, owner, lane.pin);
    await settle(counter);
    const staff = await counter.call<{ roles: { id: string; key: string }[] }>('staff.list', owner);
    const roleId = (key: string) => staff.roles.find((role) => role.key === key)!.id;
    ({ userId: cashier } = await counter.call<{ userId: string }>('staff.create', owner, {
      name: 'Maria Kambu',
      roleIds: [roleId('cashier')],
    }));
    ({ userId: technician } = await counter.call<{ userId: string }>('staff.create', owner, {
      name: 'Yosep Rumbiak',
      roleIds: [roleId('technician')],
    }));
    await counter.call('session.resetPin', owner, cashier, CASHIER_PIN);
    await counter.call('session.resetPin', owner, technician, TECH_PIN);
    await settle(counter);

    // ── The technician's phone registers and the technician signs in ─────────────────────────
    bench = await openDevice('HP Teknisi');
    await until(
      async () => (await bench.state()).session?.users ?? [],
      (users) => users.some((user) => user.id === technician),
      'the technician to reach the bench phone',
    );
    await settle(bench);
    await signIn(bench, technician, TECH_PIN);

    // ── Intake at the counter while the internet is down: photos, repair types, the customer's ──
    // ownership video (unlocking asks for it) and a DP
    await switchTo(counter, cashier, CASHIER_PIN);
    await counter.setOnline(false);
    const slots = ['front', 'back', 'left', 'right', 'top', 'bottom'];
    const photos = [];
    for (const slot of slots) photos.push({ slot, label: null, ref: await photo(counter) });
    const clip = await video(counter);
    const opened = await act(counter, 'repair')('openTicket', {
      customer: { name: 'Yakobus Mandowen', phone: '0813-4455-6677' },
      device: { brand: 'Samsung', model: 'Galaxy A54', color: 'Hitam', imei: '356789104455660' },
      complaint: 'Layar bergaris, baterai cepat habis',
      checklist: [{ item: 'screen', label: null, state: 'issue', note: 'garis hijau' }],
      peripherals: [{ item: 'charger', label: null }],
      quoteLines: [
        { kind: 'part', description: 'LCD A54', amount: 550_000 },
        { kind: 'labour', description: 'Pasang LCD', amount: 100_000 },
      ],
      repairTypes: ['screen', 'unlock'],
      ownershipVideo: clip,
      photos,
      downPayment: DP,
    });
    const ticketId = opened['ticketId'] as string;
    // The first send is cut off after the server saved it: the retry must not save it twice.
    await counter.dropNext(/\/sync\/push$/, 'afterServer');
    await counter.setOnline(true);
    await settle(counter);

    // ── The technician works offline: before photo, a second repair type, a price change ─────
    await settle(bench);
    const tech = act(bench, 'repair');
    await bench.setOnline(false);
    await tech('claimTicket', { ticketId });
    await tech('startWork', { ticketId, beforePhotos: [await photo(bench)] });
    await tech('setRepairTypes', { ticketId, repairTypes: ['screen', 'unlock', 'battery'] });
    const proposal = await tech('proposeQuoteChange', {
      ticketId,
      kind: 'part',
      description: 'Baterai A54',
      amount: EXTRA,
      reason: 'Baterai drop',
    });
    await tech('markRepaired', { ticketId, afterPhotos: [await photo(bench)] });
    // Meanwhile the counter, online, adds a screen protector the customer asked for on the phone.
    await act(counter, 'repair')('changeQuote', {
      ticketId,
      kind: 'part',
      description: 'Tempered glass',
      amount: GLASS,
      reason: 'Permintaan pelanggan',
      customerAgreed: true,
    });
    await settle(counter);
    // Back online, the first push never arrives and the first photo upload is lost on the way back.
    await bench.dropNext(/\/sync\/push$/, 'beforeServer');
    await bench.dropNext(/\/media\//, 'afterServer');
    await bench.setOnline(true);
    await settle(bench);

    // ── The customer agrees to the new price at the counter, then picks the phone up offline ─
    await settle(counter);
    const cash = act(counter, 'repair');
    await cash('applyProposal', { ticketId, lineId: proposal['lineId'], customerAgreed: true });
    await counter.setOnline(false);
    const total = INTAKE_TOTAL + GLASS + EXTRA;
    await cash('returnDevice', {
      ticketId,
      handoverPhoto: await photo(counter),
      signature: await signature(counter),
      payments: [{ account: 'cash', amount: total - DP, tendered: 800_000 }],
      checklist: HANDOVER_CHECKLIST,
    });
    const drawer = (await read(counter, 'money', 'cashDrawer', {}))[0]!;
    expect(drawer['expected']).toBe(total);
    await act(counter, 'money')('countCash', { counted: total, note: '' });
    // The power goes before the internet comes back. Nothing was sent, and nothing may be lost.
    counter = await powerCut(counter);
    await signIn(counter, cashier, CASHIER_PIN);
    expect((await read(counter, 'repair', 'getTicket', { ticketId }))[0]).toMatchObject({
      location: 'returned',
    });
    expect((await counter.state()).sync?.pendingOperationCount).toBeGreaterThan(0);
    await counter.dropNext(/\/sync\/push$/, 'afterServer');
    await counter.setOnline(true);
    await settle(counter);
    await settle(bench);

    // Every fault fired (the counter's first one before the power cut).
    expect(await counter.dropped()).toEqual(['afterServer /v1/sync/push']);
    expect(await bench.dropped()).toHaveLength(2);

    // ── A newly registered device pulls the same history ─────────────────────────────────────
    const fresh = await openDevice('HP Pemilik');
    await signIn(fresh, owner, lane.pin);
    await settle(fresh);
    for (const device of [counter, bench, fresh]) await expectNothingRefused(device);
    // Read everything as the owner, who may see the money too.
    await switchTo(counter, owner, lane.pin);
    await switchTo(bench, owner, lane.pin);

    const views = [];
    for (const device of [counter, bench, fresh]) {
      const ticket = (await read(device, 'repair', 'getTicket', { ticketId }))[0]!;
      const money = (
        await read(device, 'money', 'documentMoney', {
          kind: 'repair.ticket',
          id: ticketId,
        })
      )[0]!;
      const till = (await read(device, 'money', 'cashDrawer', {}))[0]!;
      views.push({ device: device.name, ticket, money, till });
    }
    const [first] = views;
    expect(first!.ticket).toMatchObject({
      location: 'returned',
      outcome: 'repaired',
      quoteTotal: total,
      pendingProposals: 0,
      reduced: 0,
      // Paid so far: the DP and the rest at pickup.
      downPayment: total,
    });
    expect((first!.ticket['repairTypes'] as { item: string }[]).map((type) => type.item)).toEqual([
      'screen',
      'unlock',
      'battery',
    ]);
    // The clip the counter took plays on a device that never had it: fetched and checked.
    const clips = (first!.ticket['photos'] as { slot: string; mediaId: string }[]).filter((p) =>
      p.slot.startsWith('ownershipVideo:'),
    );
    expect(clips.map((p) => p.mediaId)).toEqual([clip.mediaId]);
    await until(
      () =>
        fresh.call<{ kind: string; bytes?: Uint8Array }>('media.loadVideo', owner, {
          mediaId: clip.mediaId,
          sha256: clip.sha256,
          mime: clip.mime,
        }),
      (loaded) => loaded.kind === 'ready',
      'the ownership video to reach the new device',
    ).then((loaded) => expect(new Uint8Array(loaded.bytes!)).toEqual(WEBM));
    expect(first!.money).toMatchObject({ balance: 0, charged: total, paid: total });
    expect(
      (first!.money['entries'] as { kind: string; amount: number }[]).map((e) => [
        e.kind,
        e.amount,
      ]),
    ).toEqual([
      ['payment_received', DP],
      ['charge_recorded', total],
      ['payment_received', total - DP],
    ]);
    expect(first!.till).toMatchObject({ expected: total });
    // The handover checklist made it through the power cut and the lost reply, as it was ticked.
    expect(handoverEvent(first!.ticket)).toEqual({ note: '', checklist: HANDOVER_CHECKLIST });
    for (const view of views.slice(1)) {
      expect({
        device: view.device,
        ticket: view.ticket,
        money: view.money,
        till: view.till,
      }).toEqual({
        device: view.device,
        ticket: first!.ticket,
        money: first!.money,
        till: first!.till,
      });
    }

    // ── The server holds each change once, refused none, and its books balance ───────────────
    const db = running.server.db;
    const ops = await sql<{ type: string; n: number }>`
      SELECT type, count(*)::int AS n FROM operations
      WHERE tenant_id = ${lane.tenantId} AND (type LIKE 'repair.%' OR type LIKE 'money.%')
      GROUP BY type ORDER BY type
    `.execute(db);
    expect(Object.fromEntries(ops.rows.map((row) => [row.type, row.n]))).toEqual(
      EXPECTED_SERVER_OPS,
    );
    const refused = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM refused_operations WHERE tenant_id = ${lane.tenantId}
    `.execute(db);
    expect(refused.rows[0]!.n).toBe(0);
    const books = await sql<{ net: string; cash: string }>`
      SELECT sum(debit - credit)::text AS net,
             sum(debit - credit) FILTER (WHERE account = 'cash')::text AS cash
      FROM money_lines WHERE tenant_id = ${lane.tenantId}
    `.execute(db);
    expect(books.rows[0]).toEqual({ net: '0', cash: String(total) });
    const ticketRow = await sql<{ location: string; quoteTotal: string }>`
      SELECT location, quote_total::text AS quote_total FROM repair_tickets WHERE id = ${ticketId}
    `.execute(db);
    expect(ticketRow.rows[0]).toEqual({ location: 'returned', quoteTotal: String(total) });
    // Six intake photos, before, after, the ownership video, the handover photo and the signature:
    // all uploaded, once.
    const media = await sql<{ status: string; n: number }>`
      SELECT status, count(*)::int AS n FROM media WHERE tenant_id = ${lane.tenantId}
      GROUP BY status
    `.execute(db);
    expect(media.rows).toEqual([{ status: 'complete', n: 11 }]);
    expect(await serverChecklists(ticketId)).toEqual([HANDOVER_CHECKLIST]);
  }, 300_000);

  test('an owner cancels while the technician repairs it offline', async () => {
    // A second phone comes in at the counter.
    await switchTo(counter, cashier, CASHIER_PIN);
    const photos = [];
    for (const slot of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
      photos.push({ slot, label: null, ref: await photo(counter) });
    }
    const { ticketId } = (await act(counter, 'repair')('openTicket', {
      customer: { name: 'Ruth Wanggai', phone: '0813-5566-7788' },
      device: { brand: 'Oppo', model: 'A78', color: 'Biru', imei: '' },
      complaint: 'Tidak bisa dicas',
      checklist: [],
      peripherals: [{ item: 'charger', label: null }],
      quoteLines: [{ kind: 'part', description: 'Port cas', amount: 150_000 }],
      repairTypes: ['chargingPort'],
      photos,
      downPayment: 50_000,
    })) as { ticketId: string };
    await settle(counter);
    await switchTo(bench, technician, TECH_PIN);
    await settle(bench);

    // The technician takes it and works on it with no signal...
    await bench.setOnline(false);
    const tech = act(bench, 'repair');
    await tech('claimTicket', { ticketId });
    await tech('startWork', { ticketId, beforePhotos: [await photo(bench)] });
    await tech('markRepaired', { ticketId, afterPhotos: [await photo(bench)] });
    // ...while the owner, at the counter, cancels it at the customer's request.
    await switchTo(counter, owner, lane.pin);
    await act(counter, 'repair')('cancelTicket', {
      ticketId,
      reason: 'Pelanggan batal',
      fee: 20_000,
    });
    await settle(counter);

    await bench.setOnline(true);
    await settle(bench);
    await settle(counter);

    // The server refuses the work on a cancelled servisan, and the technician's phone says which
    // servisan each refused change was for, instead of dropping them quietly.
    const refused = (await bench.state()).sync!.rejected;
    expect(refused.map((op) => op.type).sort()).toEqual([
      'repair.marked_repaired',
      'repair.ticket_claimed',
      'repair.work_photos_added',
      'repair.work_photos_added',
      'repair.work_started',
    ]);
    const { ticketNumber } = (await read(counter, 'repair', 'getTicket', { ticketId }))[0]! as {
      ticketNumber: string;
    };
    for (const op of refused) {
      expect(op).toMatchObject({
        rejectionReason: 'repair.refusal.cancelled',
        subject: `Servisan ${ticketNumber}`,
      });
    }

    // The customer collects the phone with the counter offline: the DP less the fee goes back. The
    // charger left at intake is not there, so the checklist cannot skip it and the note says why.
    await counter.setOnline(false);
    const handover = {
      ticketId,
      handoverPhoto: await photo(counter),
      signature: await signature(counter),
      payments: [],
    };
    const charger = { kind: 'accessory', item: 'charger', label: null, done: false };
    const returnDevice = act(counter, 'repair').bind(null, 'returnDevice');
    await expect(returnDevice(handover)).rejects.toThrow(/handoverAccessories/);
    await expect(returnDevice({ ...handover, checklist: [charger] })).rejects.toThrow(
      /handoverNoteNeeded/,
    );
    const note = 'Charger belum ketemu, diantar besok';
    await returnDevice({ ...handover, checklist: [charger], note });
    await counter.setOnline(true);
    await settle(counter);
    await expectNothingRefused(counter);
    await switchTo(bench, owner, lane.pin);
    await settle(bench);
    const views = [];
    for (const device of [counter, bench]) {
      views.push({
        ticket: (await read(device, 'repair', 'getTicket', { ticketId }))[0]!,
        money: (
          await read(device, 'money', 'documentMoney', {
            kind: 'repair.ticket',
            id: ticketId,
          })
        )[0]!,
      });
    }
    expect(views[0]!.ticket).toMatchObject({
      outcome: 'cancelled',
      location: 'returned',
      technicianId: null,
    });
    expect(views[0]!.money).toMatchObject({ balance: 0, charged: 20_000, paid: 20_000 });
    expect(handoverEvent(views[0]!.ticket)).toEqual({ note, checklist: [charger] });
    expect(views[1]).toEqual(views[0]);
    expect(await serverChecklists(ticketId)).toEqual([[charger]]);
    const books = await sql<{ net: string }>`
      SELECT sum(debit - credit)::text AS net FROM money_lines WHERE tenant_id = ${lane.tenantId}
    `.execute(running.server.db);
    expect(books.rows[0]!.net).toBe('0');
  }, 300_000);
});
