// TASK 201-B (subtask d) — the in-process proof for the lane serve support behind
// `scripts/harness-serve-lane.mjs`. Two concerns, proven without a socket (the child-process proof that
// the real `.mjs` entry boots + binds loopback lives in `serve-lane-child.test.ts`):
//   • provisionLaneOwner — over a REAL `productionAuth` HarnessServer, the deterministic LANE_OTP it
//     provisions actually authenticates through the D14 login definer (200), a wrong password fails
//     closed (401), and the LANE_PIN it seeds travels in the enroll bundle and verifies (accept correct,
//     reject wrong) on the SAME argon2id. So the literals the marker hands the Maestro flows are exactly
//     the ones that enroll + unlock the app — not decorative.
//   • the ready marker — `parseLaneReady(formatLaneReady(x))` round-trips byte-for-byte, tolerates the
//     surrounding whitespace a `console.log` line carries, and rejects a non-marker line. This is the
//     format↔parse agreement the lane driver depends on to read the bound port + credentials.
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  bytesToBase64,
  createUuidV7Generator,
  verifyPinAgainst,
  type PinVerifier,
} from '@bolusi/core';
import { deriveDeviceKeypair, noblePort } from '@bolusi/test-support';
import { afterEach, describe, expect, test } from 'vitest';

import { HarnessServer } from '../src/server.js';
import {
  assertLaneLoopbackBind,
  awaitChildExit,
  awaitLaneReadyMarker,
  formatLaneReady,
  LANE_LOOPBACK,
  parseLaneReady,
  provisionLaneOwner,
  type LaneCredentials,
  type LaneReady,
} from '../src/serve-lane.js';

// In-process `app.request` routing — the origin is arbitrary (path-routed), never a bound socket.
const BASE = 'http://lane.test';

async function login(server: HarnessServer, login: string, password: string): Promise<Response> {
  return server.fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier: login, password }),
  });
}

async function enroll(
  server: HarnessServer,
  controlSession: string,
  storeId: string,
): Promise<Response> {
  const ids = createUuidV7Generator({
    now: () => server.clock.now(),
    randomBytes: (n) => noblePort.randomBytes(n),
  });
  return server.fetch(`${BASE}/v1/devices/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${controlSession}`,
      'Idempotency-Key': ids(),
    },
    body: JSON.stringify({
      deviceId: ids(),
      devicePublicKeyB64: bytesToBase64(deriveDeviceKeypair(3, 0).publicKey),
      storeId,
      deviceName: 'Tablet Kasir',
      platform: 'android',
      appVersion: '1.0.0',
    }),
  });
}

describe('task 201-B: provisionLaneOwner over a productionAuth server', () => {
  let server: HarnessServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test('the lane credentials authenticate: LANE_OTP logs in, a wrong password is rejected', async () => {
    server = await HarnessServer.boot({ productionAuth: true });
    const creds = await provisionLaneOwner(server);

    // The marker's oneTimePassword resolves through findLoginCredential (definer) + real argon2id.
    const ok = await login(server, creds.ownerLogin, creds.oneTimePassword);
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { controlSession?: unknown }).controlSession).toBe(
      'string',
    );

    // The production login path fails closed on a bad password — the seam mints no bypass.
    const bad = await login(server, creds.ownerLogin, 'not-the-lane-password');
    expect(bad.status).toBe(401);
  });

  test('the seeded LANE_PIN travels in the enroll bundle and verifies (accept correct, reject wrong)', async () => {
    server = await HarnessServer.boot({ productionAuth: true });
    const creds = await provisionLaneOwner(server);

    const loginRes = await login(server, creds.ownerLogin, creds.oneTimePassword);
    const controlSession = ((await loginRes.json()) as { controlSession: string }).controlSession;
    const enrollRes = await enroll(server, controlSession, creds.storeId);
    expect(enrollRes.status).toBe(201);
    const { bundle } = (await enrollRes.json()) as {
      bundle: { users: { id: string; pinVerifier: PinVerifier | null }[] };
    };

    const owner = bundle.users.find((u) => u.id === creds.ownerUserId);
    expect(owner?.pinVerifier).not.toBeNull();

    // The carried verifier accepts the marker's PIN and rejects a wrong one, on the SAME argon2id — so a
    // device typing LANE_PIN really unlocks, and typing anything else does not.
    const carried = owner?.pinVerifier as PinVerifier;
    expect(await verifyPinAgainst(noblePort, carried, new TextEncoder().encode(creds.pin))).toBe(
      true,
    );
    expect(await verifyPinAgainst(noblePort, carried, new TextEncoder().encode('000000'))).toBe(
      false,
    );
  });
});

describe('task 201-B: the lane ready marker round-trips', () => {
  const sample: LaneReady = {
    url: 'http://127.0.0.1:3000',
    address: '127.0.0.1',
    port: 3000,
    credentials: {
      ownerLogin: 'gudang-selatan',
      oneTimePassword: 'harness-otp-password-201b',
      pin: '314159',
      tenantId: '0a111111-1111-7111-8111-111111111111',
      storeId: '0b222222-2222-7222-8222-222222222222',
      ownerUserId: '0c333333-3333-7333-8333-333333333333',
    } satisfies LaneCredentials,
  };

  test('parseLaneReady inverts formatLaneReady exactly', () => {
    expect(parseLaneReady(formatLaneReady(sample))).toEqual(sample);
  });

  test('parseLaneReady tolerates the surrounding whitespace a console.log line carries', () => {
    // The driver reads accumulated stdout; the marker line arrives with a trailing newline (and possibly
    // leading indentation). The trim in parseLaneReady must not defeat the match.
    expect(parseLaneReady(`  ${formatLaneReady(sample)}\n`)).toEqual(sample);
  });

  test('parseLaneReady rejects a non-marker line', () => {
    expect(parseLaneReady('some other server log line')).toBeUndefined();
    // The prefix requires the exact `: ` separator — the bare marker word is not a payload line.
    expect(parseLaneReady('BOLUSI_LANE_READY without a colon')).toBeUndefined();
  });
});

// §2.5 / §2.11: the loopback-only bind is THE security control of this token-minting surface. The child
// test (serve-lane-child.test.ts) proves the HAPPY path binds 127.0.0.1 over a real socket; this proves
// the guard's REJECT branch — that a non-loopback address is actually refused — directly and falsifiably,
// so "binds loopback-only" is not a decorative, never-red `if` in the un-unit-testable `.mjs` entry.
describe('task 201-B: assertLaneLoopbackBind fails closed off loopback', () => {
  test('accepts the IPv4 loopback the lane binds (and nothing else advertises)', () => {
    expect(() => assertLaneLoopbackBind(LANE_LOOPBACK)).not.toThrow();
    expect(LANE_LOOPBACK).toBe('127.0.0.1');
  });

  test('refuses the wildcard, a LAN address, the emulator alias, IPv6 loopback, and an empty host', () => {
    // Each of these is a bind a token-minting server must NEVER accept: `0.0.0.0` exposes it on every
    // interface; `192.168.*` / `10.0.2.2` are LAN-reachable (10.0.2.2 is how the GUEST reaches the host,
    // never a host bind); `::1` is IPv6 loopback — the `10.0.2.2` NAT alias lands on the host's IPv4
    // `127.0.0.1`, so a `::1` bind is unreachable from the guest; `''` is a malformed address.
    for (const address of ['0.0.0.0', '192.168.1.5', '10.0.2.2', '::', '::1', 'localhost', '']) {
      expect(() => assertLaneLoopbackBind(address), address).toThrow(/non-loopback bind/);
    }
  });
});

// A ChildProcess stand-in: the three event surfaces awaitLaneReadyMarker touches (proc `exit`, `stdout`
// `data`, `stderr` `data`), driven synchronously so the poll/exit/timeout branches are unit-exercised
// WITHOUT spawning a real Node child (that real-boot proof is serve-lane-child.test.ts). EventEmitter
// supplies on/off/once/emit, exactly the methods the helper calls.
function makeFakeChild(): {
  readonly child: ChildProcess;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly exit: (code: number) => void;
} {
  const proc = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(proc, { stdout, stderr });
  return {
    child: proc as unknown as ChildProcess,
    stdout,
    stderr,
    exit: (code) => proc.emit('exit', code),
  };
}

describe('task 201-B: awaitLaneReadyMarker settles on marker, early exit, and timeout', () => {
  const sample: LaneReady = {
    url: 'http://127.0.0.1:3000',
    address: '127.0.0.1',
    port: 3000,
    credentials: {
      ownerLogin: 'gudang-selatan',
      oneTimePassword: 'harness-otp-password-201b',
      pin: '314159',
      tenantId: '0a111111-1111-7111-8111-111111111111',
      storeId: '0b222222-2222-7222-8222-222222222222',
      ownerUserId: '0c333333-3333-7333-8333-333333333333',
    } satisfies LaneCredentials,
  };

  test('resolves the parsed marker once it appears in stdout (poll branch)', async () => {
    const fake = makeFakeChild();
    const pending = awaitLaneReadyMarker(fake.child, { timeoutMs: 2_000, pollMs: 5 });
    // The marker arrives amid other log lines; the poll must still find it.
    fake.stdout.emit('data', 'server booting...\n');
    fake.stdout.emit('data', `${formatLaneReady(sample)}\n`);
    const outcome = await pending;
    expect(outcome.ready).toEqual(sample);
  });

  test('resolves ready=undefined and captures stderr when the child exits before the marker', async () => {
    const fake = makeFakeChild();
    // Large pollMs so the exit branch — not the poll — is what settles this.
    const pending = awaitLaneReadyMarker(fake.child, { timeoutMs: 20_000, pollMs: 10_000 });
    fake.stderr.emit('data', 'harness-serve-lane: boot failed — provision threw\n');
    fake.exit(1);
    const outcome = await pending;
    expect(outcome.ready).toBeUndefined();
    expect(outcome.stderr).toContain('boot failed');
  });

  test('the exit branch still finds a marker already printed before the child died', async () => {
    const fake = makeFakeChild();
    const pending = awaitLaneReadyMarker(fake.child, { timeoutMs: 20_000, pollMs: 10_000 });
    // Marker printed, THEN the process exits before the (10s) poll tick — exit must settle with the marker.
    fake.stdout.emit('data', `${formatLaneReady(sample)}\n`);
    fake.exit(0);
    const outcome = await pending;
    expect(outcome.ready).toEqual(sample);
  });

  test('resolves ready=undefined when the deadline elapses with no marker and no exit', async () => {
    const fake = makeFakeChild();
    const outcome = await awaitLaneReadyMarker(fake.child, { timeoutMs: 30, pollMs: 10 });
    expect(outcome.ready).toBeUndefined();
  });
});

// The teardown-wait the driver uses AFTER maestro returns. Driven with REAL children (not the
// EventEmitter fake) because the whole point is the `exitCode` transition null→set that a fake models
// as `undefined` — the guard keys on `exitCode !== null`, so only a real ChildProcess exercises it. The
// load-bearing case is a child that ALREADY exited: a bare `once('exit')` there hangs forever, and in the
// driver that hang drains the loop and exits 0, turning a red maestro run green (§2.11 false-green).
describe('task 201-B: awaitChildExit resolves even for an already-exited child (teardown false-green guard)', () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    child = undefined;
  });

  test('resolves immediately when the child has ALREADY exited before the wait is registered', async () => {
    child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    // Let it fully exit first — this is the driver's real hazard (server crashed DURING maestro), where a
    // fresh `once('exit')` would be attached to an event that has already fired and never resolve.
    await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    expect(child.exitCode).toBe(7);
    // The buggy `new Promise((r) => server.once('exit', r))` hangs here → this test times out. The guarded
    // helper sees exitCode !== null and resolves. A 2s race proves it settles rather than hanging.
    const settled = await Promise.race([
      awaitChildExit(child).then(() => 'exited' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(settled).toBe('exited');
  });

  test('resolves when a still-running child exits later', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    // Registered while the child is alive (exitCode === null) — the normal teardown path.
    const waiting = awaitChildExit(child);
    child.kill('SIGTERM');
    const settled = await Promise.race([
      waiting.then(() => 'exited' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(settled).toBe('exited');
  });
});
