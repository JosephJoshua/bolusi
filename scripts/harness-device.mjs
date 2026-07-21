// `pnpm harness:device` — the Android EMULATOR correctness driver (task 27a; testing-guide §2.6,
// 08 §5.6 stage 12). It boots the release/`test`-profile harness on the emulator, captures the
// single `BOLUSI_HARNESS_RESULT` logcat JSON, and this module's PURE `parseHarnessResult` decides
// pass/fail. The file is deliberately split the way `task-status.mjs` is: a pure, unit-tested parse
// function (proven in `packages/test-support/src/harness-device.test.ts`) plus a thin CLI that does
// the adb I/O — so the fail-safe logic is testable in CI (no emulator here) and the orchestration is
// the only unverified part.
//
// HONESTY (CLAUDE.md §2.1): every figure this lane reports is EMULATOR, never a device number. An
// emulator shares neither the CPU, the storage path, nor the RAM of the 2 GB reference device
// (D12/D20 §1), so it answers CORRECTNESS (is the byte ciphertext, does a vector match, do devices
// converge) and NOT performance. The physical-device performance gates (P-1..P-6) and SEC-AUTH-10
// are task 27b, owner-deferred — this driver never asserts them.
import { spawnSync } from 'node:child_process';

/** The logcat tag the on-device harness emits its one result document under (testing-guide §2.6). */
export const HARNESS_RESULT_TAG = 'BOLUSI_HARNESS_RESULT';

/** The result schema id — pinned so a shape change is a visible, versioned break. */
export const HARNESS_RESULT_SCHEMA = 'bolusi-harness-result/1';

/**
 * The gates the EMULATOR lane REQUIRES green (the denominator, T-14). These are the correctness legs
 * an emulator can honestly answer (D20 §1): SQLCipher at-rest with its positive control, SEC-AUTH-09
 * leg 1 (verifier bytes confined to the SQLCipher DB), the SEC-OPLOG-06 JCS vectors on the APK's own
 * Hermes 0.17 (D13), and CHAOS-01/03/06/07 convergence at reduced volume. Performance gates are NOT
 * here — an emulator cannot produce a device perf number, so P-1..P-6 belong to task 27b.
 */
export const EMULATOR_REQUIRED_GATES = Object.freeze([
  'SEC-DEV-06-at-rest',
  'SEC-AUTH-09-leg1',
  'SEC-OPLOG-06-jcs',
  'CHAOS-01',
  'CHAOS-03',
  'CHAOS-06',
  'CHAOS-07',
]);

/**
 * Extract the freshest tagged result payload from a logcat dump. Returns the JSON substring of the
 * LAST line carrying the tag, or `null` when the harness never emitted one. Taking the LAST line is
 * half of the no-stale-reuse guard: even if an old capture lingers, the freshest wins — and the run
 * id (checked in `parseHarnessResult`) is the other half, so a lingering capture with the wrong id
 * still fails rather than passing.
 */
export function extractResultPayload(logcatText) {
  const marker = `${HARNESS_RESULT_TAG}:`;
  let payload = null;
  for (const line of String(logcatText).split('\n')) {
    const at = line.indexOf(marker);
    if (at !== -1) payload = line.slice(at + marker.length).trim();
  }
  return payload;
}

/**
 * Decide pass/fail for a captured harness run. NON-ZERO (ok:false) on ANY of: no result captured,
 * unparseable JSON, non-release build, a target label missing, a run-id mismatch (stale capture),
 * a missing required gate, or any gate not `pass`. An empty/broken capture is NEVER an empty pass
 * (CLAUDE.md §2.1) — the absence of a green result is a failure, not a default success.
 *
 * @param {string} logcatText raw `adb logcat` output.
 * @param {{ expectedRunId: string, requiredGates?: readonly string[], requiredVariant?: string, requiredTarget?: string }} options
 * @returns {{ ok: boolean, errors: string[], result: object | null }}
 */
export function parseHarnessResult(logcatText, options) {
  const {
    expectedRunId,
    requiredGates = EMULATOR_REQUIRED_GATES,
    requiredVariant = 'release',
    requiredTarget = 'emulator',
  } = options ?? {};
  const errors = [];

  const payload = extractResultPayload(logcatText);
  if (payload === null) {
    return {
      ok: false,
      errors: [`no ${HARNESS_RESULT_TAG} line in the capture — the harness never emitted a result`],
      result: null,
    };
  }

  let result;
  try {
    result = JSON.parse(payload);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `${HARNESS_RESULT_TAG} payload is not parseable JSON (${error.message}) — a broken capture ` +
          `is not an empty pass (§2.1)`,
      ],
      result: null,
    };
  }

  if (result.schema !== HARNESS_RESULT_SCHEMA) {
    errors.push(
      `unexpected result schema ${JSON.stringify(result.schema)} (want ${HARNESS_RESULT_SCHEMA})`,
    );
  }
  // Release-variant marker — dev-mode JS numbers are meaningless (testing-guide §2.6).
  if (result.variant !== requiredVariant) {
    errors.push(
      `missing release-variant marker: variant=${JSON.stringify(result.variant)} (want ` +
        `${JSON.stringify(requiredVariant)}) — a dev-mode run is rejected`,
    );
  }
  // Every figure must be labelled EMULATOR (D12/D20) — a run with no target label could be misread
  // as a device number.
  if (result.target !== requiredTarget) {
    errors.push(
      `missing/wrong target label: target=${JSON.stringify(result.target)} (want ` +
        `${JSON.stringify(requiredTarget)}) — every figure must be labelled EMULATOR`,
    );
  }
  // Freshness — a stale capture reused from a prior run is refused.
  if (result.runId !== expectedRunId) {
    errors.push(
      `stale capture: run id ${JSON.stringify(result.runId)} does not match this run ` +
        `${JSON.stringify(expectedRunId)}`,
    );
  }

  const gates = Array.isArray(result.gates) ? result.gates : [];
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  for (const id of requiredGates) {
    const gate = byId.get(id);
    if (gate === undefined) {
      errors.push(`missing gate ${id} — the lane did not run it`);
    } else if (gate.status !== 'pass') {
      errors.push(`gate ${id} is ${JSON.stringify(gate.status)}: ${gate.detail ?? ''}`.trim());
    }
  }

  return { ok: errors.length === 0, errors, result };
}

// ── CLI (adb orchestration) — UNVERIFIED HERE: there is no emulator/adb on this host, so the flow
// below runs only in CI's Android-emulator lane. It is written to FAIL SAFE: any missing tool, any
// non-zero adb step, or any red/absent result makes the process exit non-zero — never a green stub.
function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function runCli(argv) {
  const apkFlag = argv.indexOf('--apk');
  const apkPath = apkFlag !== -1 ? argv[apkFlag + 1] : undefined;
  const activity = 'com.bolusi.app/com.bolusi.app.HarnessActivity'; // the flag-gated harness entry (test profile)
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;

  const fail = (message) => {
    console.error(`harness:device: ${message}`);
    process.exit(1);
  };

  if (sh('adb', ['get-state']).status !== 0) fail('no adb device/emulator online');
  if (apkPath) {
    if (sh('adb', ['install', '-r', apkPath]).status !== 0) fail(`adb install ${apkPath} failed`);
  }
  // Clear logcat so a prior run's result cannot be read (belt to the run-id braces).
  if (sh('adb', ['logcat', '-c']).status !== 0) fail('adb logcat -c failed');
  // Launch the harness with the fresh run id; the app echoes it back inside the result JSON.
  const launch = sh('adb', [
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    activity,
    '--es',
    'bolusiHarnessRunId',
    runId,
  ]);
  if (launch.status !== 0) fail(`am start ${activity} failed: ${launch.stderr}`);

  // Poll for the single tagged line (bounded — a hung harness must not hang the lane forever).
  const deadline = Date.now() + 20 * 60 * 1000;
  let logcatText = '';
  do {
    logcatText = sh('adb', ['logcat', '-d', '-s', `${HARNESS_RESULT_TAG}:I`]).stdout ?? '';
    if (extractResultPayload(logcatText) !== null) break;
    sh('sleep', ['5']);
  } while (Date.now() < deadline);

  const verdict = parseHarnessResult(logcatText, { expectedRunId: runId });
  if (!verdict.ok) {
    console.error(`harness:device: EMULATOR lane FAILED\n  - ${verdict.errors.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(
    `harness:device: EMULATOR correctness gates PASS (${EMULATOR_REQUIRED_GATES.length} gates, ` +
      `target=${verdict.result.target}, hermes=${verdict.result.hermesVersion}). ` +
      `Every figure is EMULATOR — perf gates (P-1..P-6) + SEC-AUTH-10 are task 27b (physical device).`,
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli(process.argv.slice(2));
}
