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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// ── CHAOS-03 device→host net handoff (task 198 step 4) ──────────────────────────────────────────────
// CHAOS-03 is the one emulator gate that needs the REAL host `@bolusi/server` over the wire. The driver
// starts a SEPARATE child server (harness-chaos-server.mjs), reads its one handshake line for the bound
// port + per-device bearers, `adb reverse`s the port, and hands the base URL + bearers to the APK as adb
// intent extras. The device's `parseChaosNet` (apps/mobile src/harness/part-c/chaos-net.ts) reads these
// two extras back. THESE KEYS ARE THE WIRE: they MUST equal apps/mobile src/harness/contract.ts, or the
// device silently skips CHAOS-03 (a handoff it cannot read is no handoff) — so they are pinned equal in
// apps/mobile/test/harness-producer.test.ts, exactly as HARNESS_RESULT_TAG is pinned to the emitter.

/** Intent-extra key carrying the emulator-reachable base URL (contract.ts HARNESS_CHAOS_NET_BASE_URL_EXTRA). */
export const HARNESS_CHAOS_NET_BASE_URL_EXTRA = 'bolusiHarnessChaosBaseUrl';

/** Intent-extra key carrying the per-device bearers as a JSON array of RAW tokens (contract.ts
 * HARNESS_CHAOS_NET_BEARERS_EXTRA). The device's `parseChaosNet` JSON-parses this and re-prefixes each
 * with `Bearer `; the raw token never carries the prefix over the wire. */
export const HARNESS_CHAOS_NET_BEARERS_EXTRA = 'bolusiHarnessChaosBearers';

/** The stdout marker the child server prints ONCE it is listening + seeded, so the driver learns the
 * bound port + bearers WITHOUT a second server or a race on the socket. One line, marker-prefixed JSON. */
export const HARNESS_CHAOS_NET_HANDSHAKE_MARKER = 'BOLUSI_HARNESS_CHAOS_NET';

/**
 * Render the child server's one handshake line: `${MARKER}: {"port":…,"baseUrl":…,"bearers":[…]}`.
 * Pure — the child prints exactly this and the driver parses exactly this, so the two agree by
 * construction (the round-trip is pinned in harness-producer.test.ts).
 * @param {{ port: number, baseUrl: string, bearers: readonly string[] }} handoff
 * @returns {string}
 */
export function formatChaosNetHandshake(handoff) {
  return `${HARNESS_CHAOS_NET_HANDSHAKE_MARKER}: ${JSON.stringify({
    port: handoff.port,
    baseUrl: handoff.baseUrl,
    bearers: handoff.bearers,
  })}`;
}

/**
 * Parse the child server's handshake out of its stdout — the LAST marker line wins (a prior line can
 * never mask a fresher one), and every field is validated. Returns `null` on ANY of: no marker,
 * unparseable JSON, a non-positive/non-integer port, an empty base URL, or a bearers list that is not a
 * non-empty array of non-empty strings. FAIL-SAFE (§2.1): a broken/absent handshake is null, which the
 * driver turns into a non-zero exit — never a net built from garbage that would read as a server auth
 * failure on-device. Total: never throws.
 * @param {string} childStdout
 * @returns {{ port: number, baseUrl: string, bearers: string[] } | null}
 */
export function parseChaosNetHandshake(childStdout) {
  const marker = `${HARNESS_CHAOS_NET_HANDSHAKE_MARKER}:`;
  let payload = null;
  for (const line of String(childStdout ?? '').split('\n')) {
    const at = line.indexOf(marker);
    if (at !== -1) payload = line.slice(at + marker.length).trim();
  }
  if (payload === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { port, baseUrl, bearers } = parsed;
  if (!Number.isInteger(port) || port <= 0) return null;
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  if (!Array.isArray(bearers) || bearers.length === 0) return null;
  if (!bearers.every((token) => typeof token === 'string' && token !== '')) return null;
  return { port, baseUrl, bearers };
}

/**
 * The `am start … --es` argv fragment that hands the net off to the APK. Bearers travel as a JSON
 * string of RAW tokens under the bearers key; the device's `parseChaosNet` JSON-parses them and
 * re-prefixes each `Bearer `. Pure — the exact triples the intent forwards to RN initialProps.
 * @param {{ baseUrl: string, bearers: readonly string[] }} handoff
 * @returns {string[]}
 */
export function chaosNetExtras(handoff) {
  return [
    '--es',
    HARNESS_CHAOS_NET_BASE_URL_EXTRA,
    handoff.baseUrl,
    '--es',
    HARNESS_CHAOS_NET_BEARERS_EXTRA,
    JSON.stringify(handoff.bearers),
  ];
}

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

/** How many logcat lines the failure path prints. Bounded so one red run stays a readable CI log. */
export const FAILURE_LOGCAT_TAIL_LINES = 400;

/**
 * Bound a captured dump to its LAST `maxLines` lines, prefixed with a count of what was elided.
 * The TAIL, not the head: a crash, an ANR and the give-up moment are all at the END of the buffer.
 * Pure, so the bound itself is unit-testable without an emulator (T-11 — a dump nobody has watched
 * truncate is a dump that might print 200 000 lines into the job log the first time it fires).
 */
export function tailLines(text, maxLines = FAILURE_LOGCAT_TAIL_LINES) {
  const lines = String(text).split('\n');
  // A trailing newline yields one empty final element; drop it so the elided count is honest.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return lines.join('\n');
  const dropped = lines.length - maxLines;
  return [
    `… [${dropped} earlier line(s) elided — showing the last ${maxLines}]`,
    ...lines.slice(dropped),
  ].join('\n');
}

/**
 * The markers that mean `am start` did NOT start anything — even though it EXITED 0.
 *
 * This is the §2.11 shape exactly: `am start` reports component-not-found as `Error type 3` /
 * `Error: Activity class {…} does not exist.` on **stdout** and still exits **0**. A launch check
 * that reads only the exit status is therefore green for the wrong reason, and CI run 29990800850
 * is what that costs: the driver "successfully launched" a component that has never existed
 * (task 175 §A — there is no `HarnessActivity` anywhere in this repo) and then polled for 20 min 13 s
 * for a result that could not come. Positive evidence of failure only — the absence of `Status: ok`
 * is NOT treated as a failure, so a future entry point (deep link, MainActivity) is not pre-rejected.
 */
// Ordered MOST INFORMATIVE FIRST — the first match becomes the one-line reason at the bottom of the
// job log, and `Error: Activity class {…} does not exist.` names the component while `Error type 3`
// does not. The full stdout is printed either way.
const AM_START_FAILURE_PATTERNS = Object.freeze([
  /^Error:.*/m,
  /does not exist/i,
  /^Error type \d+/m,
  /Exception/,
  /^Status:\s*(?:error|timeout)/im,
  /Permission Denial/i,
]);

/**
 * Return the offending line from `am start` output, or `null` when nothing says it failed.
 * @param {string} launchText `am start` stdout and stderr, concatenated.
 * @returns {string | null}
 */
export function amStartFailureReason(launchText) {
  const text = String(launchText ?? '');
  for (const pattern of AM_START_FAILURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    // Report the whole offending LINE, not just the matched fragment — `Error type 3` alone does
    // not name the component, and the next reader needs to know which one was missing.
    const line = text.split('\n').find((candidate) => candidate.includes(match[0]));
    return (line ?? match[0]).trim();
  }
  return null;
}

// ── CLI (adb orchestration) — UNVERIFIED HERE: there is no emulator/adb on this host, so the flow
// below runs only in CI's Android-emulator lane. It is written to FAIL SAFE: any missing tool, any
// non-zero adb step, or any red/absent result makes the process exit non-zero — never a green stub.
//
// OBSERVABILITY (task 176). `sh` captures rather than inherits stdio, which is deliberate — the poll
// needs the logcat text as a STRING. The cost is that a captured buffer nobody prints is a buffer
// thrown away: the 20-minute red run above emitted literally ZERO adb lines into the job log. So the
// contract is now: capture as before, and every FAILURE path prints what it captured (`formatCapture`)
// plus an unfiltered logcat dump (`dumpFailureDiagnostics`). Callers still read `.status`/`.stdout`.
function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Render one captured `spawnSync` result for the job log — status, stdout, stderr, all of it. */
function formatCapture(label, res, { maxLines = Number.POSITIVE_INFINITY } = {}) {
  const lines = [
    `── ${label}`,
    `   status=${res.status ?? 'null'}${res.signal ? ` signal=${res.signal}` : ''}`,
  ];
  if (res.error) lines.push(`   spawn error: ${res.error.message}`);
  const out = String(res.stdout ?? '').trimEnd();
  const err = String(res.stderr ?? '').trimEnd();
  lines.push(out === '' ? '   <stdout empty>' : `   stdout:\n${tailLines(out, maxLines)}`);
  lines.push(err === '' ? '   <stderr empty>' : `   stderr:\n${tailLines(err, maxLines)}`);
  return lines.join('\n');
}

/**
 * Dump what the device actually said, on the failure path ONLY.
 *
 * UNFILTERED ON PURPOSE. The poll below filters logcat to `-s BOLUSI_HARNESS_RESULT:I`, a **tag**
 * filterspec, which excludes `AndroidRuntime`, `ActivityManager` and `ReactNativeJS` BY CONSTRUCTION.
 * A crash, an ANR or a JS boot error could never have appeared in the polled text — so when task 175
 * searched the 16 547-line job log for `FATAL EXCEPTION` and found none, that absence was not
 * evidence of anything. This dump is the only place the lane can see them. It also answers, for free,
 * the question that log could not: whether the app boots at all on-device (task 160).
 *
 * The crash buffer is dumped separately and first: it is small, it is pure signal, and it SURVIVES
 * the process death that would otherwise be the interesting event.
 */
function dumpFailureDiagnostics() {
  console.error(
    'harness:device: ── FAILURE DIAGNOSTICS (unfiltered — the poll cannot see any of this) ──',
  );
  console.error(
    formatCapture('adb logcat -d -b crash', sh('adb', ['logcat', '-d', '-b', 'crash']), {
      maxLines: FAILURE_LOGCAT_TAIL_LINES,
    }),
  );
  console.error(
    formatCapture(
      `adb logcat -d (unfiltered, last ${FAILURE_LOGCAT_TAIL_LINES} lines)`,
      sh('adb', ['logcat', '-d']),
      { maxLines: FAILURE_LOGCAT_TAIL_LINES },
    ),
  );
}

/**
 * Start the CHAOS-03 child server and wait (bounded) for its one handshake line. The child is a
 * SEPARATE Node process (harness-chaos-server.mjs) so its socket + PGlite handle outlive the driver's
 * spawnSync calls — a server must stay up during the 20-minute logcat poll. Its stdout is read via
 * async data events, which is precisely WHY runCli is async: a spawnSync busy-wait would block the
 * event loop and never see the child's output. Returns the live child + a promise of the parsed
 * handshake, `null` on timeout OR early child exit (the caller fails the lane — never a silent skip).
 *
 * Exported so the host child-boot test (packages/harness/scenarios/chaos-net-server-child.test.ts)
 * drives THIS exact spawn→poll→handshake path against the REAL child server — the §2.11 proof that the
 * child actually produces a driver-parseable handshake and tears down clean, not just that it typechecks.
 */
export function startChaosNetServer(timeoutMs) {
  const script = fileURLToPath(new URL('./harness-chaos-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const handshake = new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(value);
    };
    // A child that dies BEFORE the handshake is a failure, not a wait — parse whatever it managed to
    // print (usually nothing) and resolve, so the caller fails fast instead of blocking to the deadline.
    child.once('exit', () => finish(parseChaosNetHandshake(stdout)));
    const timer = setInterval(() => {
      const parsed = parseChaosNetHandshake(stdout);
      if (parsed !== null) finish(parsed);
      else if (Date.now() >= deadline) finish(null);
    }, 200);
  });
  return { child, handshake, readStdout: () => stdout, readStderr: () => stderr };
}

async function runCli(argv) {
  const apkFlag = argv.indexOf('--apk');
  const apkPath = apkFlag !== -1 ? argv[apkFlag + 1] : undefined;
  const activity = 'com.bolusi.app/com.bolusi.app.HarnessActivity'; // the flag-gated harness entry (test profile)
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;

  // CHAOS-03 child server + `adb reverse` TEARDOWN — registered ONCE, fires on EVERY exit path (fail()
  // exits 1, the success path exits 0, an unhandled throw exits non-zero; 'exit' catches all). The
  // handler is synchronous by necessity (Node runs 'exit' listeners sync): `kill` is a signal and
  // `adb reverse --remove` is spawnSync, both legal here — leaving neither a stray forward nor a
  // zombie server behind on the CI host.
  let chaosChild = null;
  let reversedPort = null;
  process.on('exit', () => {
    if (reversedPort !== null) sh('adb', ['reverse', '--remove', `tcp:${reversedPort}`]);
    if (chaosChild !== null) chaosChild.kill('SIGTERM');
  });

  // Every failure path prints what it captured, THEN the unfiltered device log, THEN the one-line
  // verdict — verdict last, so the reason is the final thing a reader sees at the bottom of the job.
  const fail = (message, captures = []) => {
    for (const capture of captures) console.error(capture);
    dumpFailureDiagnostics();
    console.error(`harness:device: ${message}`);
    process.exit(1);
  };

  const state = sh('adb', ['get-state']);
  if (state.status !== 0)
    fail('no adb device/emulator online', [formatCapture('adb get-state', state)]);
  if (apkPath) {
    const install = sh('adb', ['install', '-r', apkPath]);
    if (install.status !== 0) {
      fail(`adb install ${apkPath} failed`, [formatCapture(`adb install -r ${apkPath}`, install)]);
    }
  }

  // Stand up the CHAOS-03 host server + wire `adb reverse` BEFORE `am start`, so the base URL + bearers
  // ride the launch intent. CHAOS-03 is a REQUIRED gate (EMULATOR_REQUIRED_GATES), so a net that never
  // materialises must RED the lane, never skip it — hence every branch below fails non-zero.
  const chaos = startChaosNetServer(60 * 1000);
  chaosChild = chaos.child;
  const handshake = await chaos.handshake;
  if (handshake === null) {
    fail(
      'CHAOS-03 net child server never produced a handshake — cannot hand its base URL + bearers to ' +
        'the APK, so CHAOS-03 could not run (a required gate cannot skip, §2.11)',
      [
        formatCapture('harness-chaos-server.mjs (child)', {
          status: chaos.child.exitCode,
          signal: chaos.child.signalCode,
          stdout: chaos.readStdout(),
          stderr: chaos.readStderr(),
        }),
      ],
    );
  }
  // Reverse the bound port so the device reaches the host as `127.0.0.1:<port>` (identical for the
  // emulator and a future physical device — task 27b — unlike the emulator-only `10.0.2.2`).
  const reverse = sh('adb', ['reverse', `tcp:${handshake.port}`, `tcp:${handshake.port}`]);
  if (reverse.status !== 0) {
    fail(
      `adb reverse tcp:${handshake.port} failed — the device cannot reach the CHAOS-03 host server`,
      [formatCapture(`adb reverse tcp:${handshake.port} tcp:${handshake.port}`, reverse)],
    );
  }
  reversedPort = handshake.port;

  // Clear logcat so a prior run's result cannot be read (belt to the run-id braces).
  const clear = sh('adb', ['logcat', '-c']);
  if (clear.status !== 0) fail('adb logcat -c failed', [formatCapture('adb logcat -c', clear)]);
  // Launch the harness with the fresh run id + the CHAOS-03 net handoff; the app echoes the run id back
  // inside the result JSON and reads the net extras via `parseChaosNet`.
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
    ...chaosNetExtras({ baseUrl: handshake.baseUrl, bearers: handshake.bearers }),
  ]);
  // FAIL FAST on a launch that did not launch. `am start` EXITS 0 for a component that does not
  // exist and says so only on stdout, so the exit status alone is not a check (see
  // AM_START_FAILURE_PATTERNS). Reading stdout turns "no result after 20 minutes" into "the activity
  // does not exist" in about 30 seconds — which is the entire difference between a diagnosis and a bill.
  const launchCapture = formatCapture(`adb shell am start -W -n ${activity}`, launch);
  const launchFailure = amStartFailureReason(`${launch.stdout ?? ''}\n${launch.stderr ?? ''}`);
  if (launchFailure !== null) {
    fail(
      `am start ${activity} did NOT launch (it exited ${launch.status} — am start reports this ` +
        `on stdout, not via its exit status): ${launchFailure}`,
      [launchCapture],
    );
  }
  if (launch.status !== 0) fail(`am start ${activity} failed`, [launchCapture]);

  // Poll for the single tagged line (bounded — a hung harness must not hang the lane forever).
  //
  // ⚠ TAG-VS-SUBSTRING TRAP — READ THIS BEFORE BUILDING THE PRODUCER (task 175 leg 2).
  // `-s BOLUSI_HARNESS_RESULT:I` is a **tag** filterspec: logcat drops every line whose TAG is not
  // `BOLUSI_HARNESS_RESULT`, before this process sees a byte of it. `extractResultPayload` then greps
  // for the SUBSTRING `BOLUSI_HARNESS_RESULT:` anywhere in a line. Those two are not the same test,
  // and the gap between them is a silent, total failure:
  //   • A React Native `console.log('BOLUSI_HARNESS_RESULT: {…}')` reaches logcat under the tag
  //     `ReactNativeJS`. The substring grep WOULD match that line. The `-s` filter DELETES it first.
  //     Result: a correct-looking emitter, a correct-looking parser, and a permanent empty capture.
  //   • Only `android.util.Log.i(HARNESS_RESULT_TAG, json)` from native code actually sets the TAG.
  // So EMITTER AND FILTER MUST BE CHOSEN TOGETHER. Either emit natively under the tag and keep `-s`,
  // or drop `-s`, dump unfiltered, and let the substring grep do the work. Picking one in isolation
  // reproduces CI run 29990800850 exactly — with a producer in place.
  const deadline = Date.now() + 20 * 60 * 1000;
  const startedAt = Date.now();
  let poll = { status: 0, stdout: '', stderr: '' };
  let logcatText = '';
  let polls = 0;
  do {
    poll = sh('adb', ['logcat', '-d', '-s', `${HARNESS_RESULT_TAG}:I`]);
    polls += 1;
    logcatText = poll.stdout ?? '';
    if (extractResultPayload(logcatText) !== null) break;
    sh('sleep', ['5']);
  } while (Date.now() < deadline);

  const verdict = parseHarnessResult(logcatText, { expectedRunId: runId });
  if (!verdict.ok) {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    fail(`EMULATOR lane FAILED\n  - ${verdict.errors.join('\n  - ')}`, [
      `── polled ${polls}× over ${elapsedSeconds}s for run id ${runId}`,
      formatCapture(
        `adb logcat -d -s ${HARNESS_RESULT_TAG}:I (the TAG-FILTERED text the poll actually saw)`,
        poll,
        { maxLines: FAILURE_LOGCAT_TAIL_LINES },
      ),
    ]);
  }
  console.log(
    `harness:device: EMULATOR correctness gates PASS (${EMULATOR_REQUIRED_GATES.length} gates, ` +
      `target=${verdict.result.target}, hermes=${verdict.result.hermesVersion}). ` +
      `Every figure is EMULATOR — perf gates (P-1..P-6) + SEC-AUTH-10 are task 27b (physical device).`,
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    // An unhandled throw is still a FAILURE (§2.1), never a silent zero — the 'exit' handler still
    // runs and tears down the child + reverse.
    console.error(`harness:device: driver aborted: ${String(error)}`);
    process.exit(1);
  });
}
