// The device ENTRY that ties deliverable #3 (run gates) to #2 (emit). Reads the runtime facts only a
// running APK knows — the release/debug variant (`__DEV__`) and the bundled Hermes version — assembles
// the honest result via the PURE run.ts, and emits it under the driver's tag.
//
// ── THIS IS THE HARNESS'S ONE NATIVE-BINDING SITE (task 178) ────────────────────────────────────
// Like `apps/mobile/index.ts` is for the app, this is the ONE file in the harness that binds the native
// modules the on-device gate runners need — op-sqlite (via `@bolusi/db-client/op-sqlite`), the AES-256-GCM
// AEAD (`deviceColumnAead`), and expo-file-system — and injects them DOWN into the pure runners (the
// at-rest seed, the JCS runner, and CHAOS-01's convergence DB seam — task 181). It pulls
// in emit.ts (the native tagged emitter) and RN's `__DEV__`/`HermesInternal` globals, none of which exist
// in Node, so no Node test imports it (the pure pieces it calls ARE Node-tested: run.ts in
// harness-producer.test.ts, the at-rest env in at-rest-device-env.test.ts, the JCS runner in
// jcs-device-runner.test.ts). Keeping these imports HERE is what keeps registry.ts / run.ts op-sqlite-free
// so `flag.test.ts` / `harness-producer.test.ts` still run on Node.
import { Directory, File, Paths } from 'expo-file-system';

import { deleteOpSqliteDatabase, openOpSqliteDriver } from '@bolusi/db-client/op-sqlite';

import { deviceColumnAead } from '../ports/aead.js';
import { emitHarnessResult } from './emit.js';
import { loadHarness, type HarnessRunners } from './registry.js';
import {
  buildHarnessResult,
  resolveGateResults,
  type DeviceGateRunners,
  type HarnessRuntimeFacts,
} from './run.js';
import {
  AT_REST_GATE_ID,
  runVerifierAtRestGate,
  VERIFIER_AT_REST_GATE_ID,
} from './part-c/at-rest-device-ctx.js';
import { createAtRestDeviceEnv, type AtRestDeviceSeams } from './part-c/at-rest-device-env.js';
import {
  CHAOS01_GATE_ID,
  runChaos01Gate,
  type ChaosDbSeams,
} from './part-c/chaos-01-device-env.js';
import { JCS_GATE_ID, runJcsGate } from './part-c/jcs-device-runner.js';

declare const __DEV__: boolean;

interface HermesRuntime {
  getRuntimeProperties?: () => Record<string, string>;
}

/** The Hermes engine the shipping APK bundles (D13). Best-effort — the driver reports it, not gates on it. */
function hermesVersion(): string {
  const hermes = (globalThis as unknown as { HermesInternal?: HermesRuntime }).HermesInternal;
  return hermes?.getRuntimeProperties?.()['OSS Release Version'] ?? 'unknown';
}

function runtimeFacts(): HarnessRuntimeFacts {
  return {
    profile: 'test',
    // The driver REQUIRES `release`. A debug build reports `debug` HONESTLY and the driver rejects it —
    // never a mislabelled release, so a dev-mode capture cannot masquerade as an acceptance run.
    variant: __DEV__ ? 'debug' : 'release',
    // This producer serves the `android-emulator` CI job (the AVD). 27b (physical device) owns the
    // `device` label; nothing on THIS lane touches hardware, so the label names the lane, not an assumed
    // device number (D12/D20 §1).
    target: 'emulator',
    hermesVersion: hermesVersion(),
  };
}

/** `<documentDirectory>/bolusi-harness-atrest/` — a throwaway directory the at-rest seed owns. Never the
 * production `bolusi.db` area, so it cannot collide with anything (HarnessActivity never boots the app). */
const HARNESS_DIR = 'bolusi-harness-atrest';

/** `<documentDirectory>/bolusi-harness-chaos/` — the throwaway area CHAOS-01's convergence DBs live in.
 * Separate from the at-rest dir so the two device runners never share a file; both are outside the app's
 * production `bolusi.db` area (HarnessActivity never boots the app). */
const HARNESS_CHAOS_DIR = 'bolusi-harness-chaos';

/** op-sqlite's `location` is a plain absolute directory path; expo-file-system speaks `file://` URIs.
 * Strip the scheme so the driver and the byte reader address the SAME physical directory. */
function stripFileScheme(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

/**
 * Bind the at-rest seams to the device's real modules: op-sqlite for the driver, `deviceColumnAead` for
 * the production column cipher, and expo-file-system for the physical byte reads/copies.
 *
 * ONLY the op-sqlite path + the real file bytes here are emulator-verifiable (there is no AVD on the dev
 * host, D12/D13); the seed + coverage LOGIC these feed is proven on Node against better-sqlite3 in
 * at-rest-device-env.test.ts. The `location`/`file://` coupling below is exactly the device-only seam
 * the emulator lane exercises.
 */
function deviceAtRestSeams(): AtRestDeviceSeams {
  const dir = new Directory(Paths.document, HARNESS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  const location = stripFileScheme(dir.uri);
  const fileFor = (name: string): File => new File(dir, name);
  return {
    aead: deviceColumnAead,
    driverFactory: openOpSqliteDriver,
    location,
    async readBytesOf(name) {
      return new Uint8Array(await fileFor(name).arrayBuffer());
    },
    async copyDbFile(srcName, dstName) {
      const bytes = new Uint8Array(await fileFor(srcName).arrayBuffer());
      const dst = fileFor(dstName);
      if (dst.exists) dst.delete();
      dst.create();
      dst.write(bytes);
    },
    removeDb(name) {
      // op-sqlite's own delete removes the main file; deleteOpSqliteDatabase also clears the WAL/SHM
      // sidecars by name, so a stale seed can never masquerade as this run's.
      deleteOpSqliteDatabase({ name, location });
      return Promise.resolve();
    },
  };
}

/**
 * Bind the CHAOS-01 convergence DB seam to op-sqlite, the ONLY dependency its pure runner needs. Mirrors
 * `deviceAtRestSeams` but driver-only — no AEAD or file bytes, since convergence is a digest-only property
 * over the projection tables. `location` is the same `location`/`file://` coupling the at-rest seam uses,
 * so the op-sqlite driver and `deleteOpSqliteDatabase` address the SAME physical directory.
 */
function deviceChaosSeams(): ChaosDbSeams {
  const dir = new Directory(Paths.document, HARNESS_CHAOS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  const location = stripFileScheme(dir.uri);
  return {
    driverFactory: openOpSqliteDriver,
    location,
    removeDb(name) {
      deleteOpSqliteDatabase({ name, location });
      return Promise.resolve();
    },
  };
}

/**
 * Build the on-device gate runners from the loaded harness. Each entry produces a REAL `passed`/`failed`
 * (§2.11). CHAOS-01 is wired here (its client-only convergence needs only op-sqlite — task 181); the
 * remaining chaos ids (CHAOS-03/06/07) deliberately have NO entry, so run.ts skips them honestly — they
 * need a real SERVER round-trip a single emulator cannot host (D24 option C, see run.ts).
 */
function buildDeviceRunners(harness: HarnessRunners): DeviceGateRunners {
  const env = createAtRestDeviceEnv(deviceAtRestSeams());
  return {
    // SEC-DEV-06 L6 — all 11 signed-off columns are ciphertext at rest (the priority, deliverable 1).
    [AT_REST_GATE_ID]: () => harness.runAtRest(env),
    // SEC-AUTH-09 leg 1 — the PIN-verifier material specifically, on the same real seed.
    [VERIFIER_AT_REST_GATE_ID]: () => runVerifierAtRestGate(env),
    // SEC-OPLOG-06 — the shared RFC 8785 JCS vectors, replayed on Hermes.
    [JCS_GATE_ID]: runJcsGate,
    // CHAOS-01 — multi-device projection convergence over op-sqlite (client-only, no server; task 181).
    [CHAOS01_GATE_ID]: () => runChaos01Gate(deviceChaosSeams()),
  };
}

/**
 * Run the required gates and emit the single tagged result. Called ONCE from HarnessActivity's React
 * root (HarnessApp). `runId` is the driver's `--es bolusiHarnessRunId` value, echoed back so the
 * driver's freshness check matches; an empty/absent run id is emitted honestly and the driver fails the
 * lane on it — never a silent pass.
 *
 * `loadHarness()` returning null (flag off) yields no runners and an all-skipped honest partial. With
 * the flag on, `buildDeviceRunners` binds op-sqlite + `deviceColumnAead` + expo-file-system and the
 * at-rest / SEC-AUTH-09 / JCS / CHAOS-01 gates produce real verdicts; the server-round-trip chaos gates
 * (CHAOS-03/06/07) stay honestly skipped (task 181, D24 option C). A runner that throws on device becomes
 * a red naming its id (resolveGateResults), never a gap.
 */
export async function runAndEmitHarness(runId: string): Promise<void> {
  const harness = loadHarness();
  const runners: DeviceGateRunners = harness === null ? {} : buildDeviceRunners(harness);
  const gates = await resolveGateResults(harness, runners);
  emitHarnessResult(buildHarnessResult(runId, gates, runtimeFacts()));
}
