// The production-auth emulator lane's serve support (task 201-B, subtask d) — the testable core behind
// the thin `scripts/harness-serve-lane.mjs` entry (a root .mjs cannot resolve bare `@bolusi/*`
// specifiers, so all logic lives here in harness src and is re-exported from the barrel the .mjs imports
// via `dist/`). Two concerns:
//   • provisionLaneOwner — stand a lane-ready owner in a booted production-auth server: provision with
//     the deterministic LANE_OTP, then seed the owner's LANE_PIN verifier so it travels in the enroll
//     bundle. Returns the credentials the Maestro flows type as literals.
//   • the ready marker — a single, round-trippable stdout line the lane driver waits on before it runs
//     `maestro`, carrying the bound loopback port and the provisioned credentials.
import type { ChildProcess } from 'node:child_process';

import type { ProvisionResult } from '@bolusi/server/test-support';

import {
  LANE_OTP,
  LANE_OWNER_LOGIN,
  LANE_PIN,
  provisionHarnessOwner,
  seedOwnerPin,
  type ProvisionableServer,
} from './harness-provision.js';

/**
 * The fixed port the emulator lane binds — matches the APK's `EXPO_PUBLIC_API_URL`
 * (`http://10.0.2.2:3000`). `10.0.2.2` is the Android emulator's NAT alias for the host's IPv4 loopback,
 * so the guest app reaches this server's `127.0.0.1:3000` bind directly — NO `adb reverse` (that forwards
 * the guest's OWN `127.0.0.1`, a path the app, which dials `10.0.2.2`, never takes). Tests pass `0` for an
 * ephemeral port so parallel servers never collide.
 */
export const LANE_PORT = 3000;

/** The stdout token the serve entry prints ONCE the server is listening + provisioned. */
export const LANE_READY_MARKER = 'BOLUSI_LANE_READY';

/**
 * The ONE host the lane may bind: IPv4 loopback. The guest app does not dial the host directly — it dials
 * the `10.0.2.2` NAT alias, which the emulator maps to the host's IPv4 `127.0.0.1`. So this loopback bind
 * is both sufficient (the emulator still reaches it) and the only safe bind (never the LAN).
 */
export const LANE_LOOPBACK = '127.0.0.1';

/**
 * §2.5 fail-closed guard for the serve entry: the lane server mints REAL control-session + device tokens,
 * so it MUST bind {@link LANE_LOOPBACK} and nothing else. Throws on any other host — a LAN address, the
 * `0.0.0.0` wildcard, the `10.0.2.2` emulator alias (that is how the guest REACHES the host, never what the
 * host BINDS), or even IPv6 `::1` (the `10.0.2.2` alias lands on the host's IPv4 `127.0.0.1`, so a `::1`
 * bind is unreachable as well as off-contract). Pure and exported so the REJECT branch is unit-falsifiable
 * — the security control is closed by construction, not by a decorative `if` buried in the un-unit-testable
 * `.mjs` entry (§2.11).
 */
export function assertLaneLoopbackBind(address: string): void {
  if (address !== LANE_LOOPBACK) {
    throw new Error(
      `harness-serve-lane: refusing non-loopback bind ${address} — a token-minting server must not reach the LAN`,
    );
  }
}

/** The lane owner's credentials — the literals the pending Maestro flows type to enroll + unlock. */
export interface LaneCredentials {
  readonly ownerLogin: string;
  readonly oneTimePassword: string;
  readonly pin: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly ownerUserId: string;
}

/**
 * Provision the lane owner in a booted production-auth server: the REAL `provisionTenant` transaction
 * with the deterministic {@link LANE_OTP}, then seed the owner's {@link LANE_PIN} verifier (real
 * argon2id) so the enroll bundle carries it. The server MUST have been booted with `productionAuth`
 * (so login resolves via the D14 definer path) — this only provisions; it does not boot or listen.
 */
export async function provisionLaneOwner(server: ProvisionableServer): Promise<LaneCredentials> {
  const provisioned: ProvisionResult = await provisionHarnessOwner(server, {
    oneTimePassword: LANE_OTP,
  });
  await seedOwnerPin(server, {
    tenantId: provisioned.tenantId,
    userId: provisioned.ownerUserId,
    asOfDeviceId: provisioned.systemDeviceId,
    pin: LANE_PIN,
  });
  // We provision exactly one store (LANE_STORE_NAME), so storeIds[0] is always present; assert it
  // loudly rather than silently ship an `undefined` storeId the Maestro enroll flow would fail on.
  const [storeId] = provisioned.storeIds;
  if (storeId === undefined) {
    throw new Error('provisionLaneOwner: provisionTenant returned no store');
  }
  return {
    ownerLogin: LANE_OWNER_LOGIN,
    oneTimePassword: LANE_OTP,
    pin: LANE_PIN,
    tenantId: provisioned.tenantId,
    storeId,
    ownerUserId: provisioned.ownerUserId,
  };
}

/** The ready-marker payload: where the server bound + the credentials to enroll against it. */
export interface LaneReady {
  readonly url: string;
  readonly address: string;
  readonly port: number;
  readonly credentials: LaneCredentials;
}

/**
 * Render the ready marker as ONE stdout line (`BOLUSI_LANE_READY: {json}`). The payload is
 * `JSON.stringify` output — no leading/trailing space, no embedded newline (every field is a clean
 * string/number) — so {@link parseLaneReady} round-trips it byte-for-byte.
 */
export function formatLaneReady(ready: LaneReady): string {
  return `${LANE_READY_MARKER}: ${JSON.stringify(ready)}`;
}

/**
 * Parse a ready marker back out of a stdout line, or `undefined` if the line is not a marker. Trims
 * first (so a trailing newline from `console.log` or surrounding whitespace does not defeat the match),
 * then requires the exact `BOLUSI_LANE_READY: ` prefix.
 */
export function parseLaneReady(line: string): LaneReady | undefined {
  const trimmed = line.trim();
  const prefix = `${LANE_READY_MARKER}: `;
  if (!trimmed.startsWith(prefix)) return undefined;
  return JSON.parse(trimmed.slice(prefix.length)) as LaneReady;
}

/**
 * Scan accumulated stdout for the FIRST ready-marker line, or `undefined` if none is present yet. The
 * serve entry prints exactly one marker, but it arrives amid other server log lines, so we split and test
 * each — {@link parseLaneReady} rejects the non-marker ones.
 */
export function findLaneReadyMarker(stdout: string): LaneReady | undefined {
  for (const line of stdout.split('\n')) {
    const parsed = parseLaneReady(line);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** The result of waiting on the ready marker: the parsed marker (or `undefined`) plus captured output. */
export interface LaneReadyOutcome {
  readonly ready: LaneReady | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for {@link awaitLaneReadyMarker}: the overall deadline and the stdout poll interval. */
export interface AwaitLaneReadyOptions {
  readonly timeoutMs: number;
  readonly pollMs?: number;
}

/**
 * Wait for the serve entry's ready marker on `child`'s stdout — the ONE poll both the child-process test
 * and the lane driver share (§2.8: the second copy of this loop is the extraction trigger). Resolves with
 * {@link LaneReadyOutcome} when any of three things happens, whichever is first:
 *   • the marker appears in accumulated stdout (`ready` = the parsed marker);
 *   • the child exits before the marker (`ready` = undefined — the driver then reds the lane, §2.11, and
 *     the captured `stderr` explains why the boot failed);
 *   • the deadline elapses (`ready` = undefined).
 * Never rejects — a missing marker is a value (`ready === undefined`), not a throw, so the one caller
 * (fail-closed) handles boot failure and timeout on the same branch. All listeners + the timer are torn
 * down on settle, so the child can exit cleanly afterward.
 */
export function awaitLaneReadyMarker(
  child: ChildProcess,
  options: AwaitLaneReadyOptions,
): Promise<LaneReadyOutcome> {
  const pollMs = options.pollMs ?? 200;
  return new Promise<LaneReadyOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Every listener + the poll timer registers its own teardown here, so `settle` tears them ALL down in
    // one pass without forward-referencing a `let timer` (which `prefer-const` would reject anyway).
    const cleanups: Array<() => void> = [];
    const settle = (ready: LaneReady | undefined): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve({ ready, stdout, stderr });
    };
    const onStdout = (chunk: unknown): void => {
      stdout += String(chunk);
    };
    const onStderr = (chunk: unknown): void => {
      stderr += String(chunk);
    };
    const onExit = (): void => settle(findLaneReadyMarker(stdout));
    child.stdout?.on('data', onStdout);
    cleanups.push(() => child.stdout?.off('data', onStdout));
    child.stderr?.on('data', onStderr);
    cleanups.push(() => child.stderr?.off('data', onStderr));
    child.once('exit', onExit);
    cleanups.push(() => child.off('exit', onExit));
    const deadline = Date.now() + options.timeoutMs;
    const timer = setInterval(() => {
      const parsed = findLaneReadyMarker(stdout);
      if (parsed !== undefined) settle(parsed);
      else if (Date.now() >= deadline) settle(undefined);
    }, pollMs);
    cleanups.push(() => clearInterval(timer));
  });
}

/**
 * Resolve when `child` has exited — or IMMEDIATELY if it has ALREADY exited. A bare `child.once('exit')`
 * is a trap for a process that may already be gone: `exit` fires exactly once and is never re-emitted, so
 * a listener attached after the fact waits forever. In the lane driver that hang is not benign — with no
 * other pending handle the event loop drains and Node exits the driver 0, turning a RED maestro run GREEN
 * (a §2.11 false-green: tearing down a server that crashed mid-run must not swallow the flow's verdict).
 * The `exitCode`/`signalCode` check and the listener registration run synchronously in one tick, so an
 * exit cannot slip between them.
 */
export function awaitChildExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}
