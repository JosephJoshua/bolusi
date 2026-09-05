// Unit tests for the `pnpm harness:device` result-JSON parser (`scripts/harness-device.mjs`, task
// 27a). The driver boots the emulator, runs the release/`test`-profile harness, captures the
// `BOLUSI_HARNESS_RESULT` logcat JSON (testing-guide §2.6) and this parser decides pass/fail. It is
// the fail-safe of the whole lane, so it is proven to go NON-ZERO on every way a run can be bad —
// any gate red, a missing gate, a dev-mode (non-release) build, a stale capture reused from a prior
// run, a truncated/absent result, unparseable JSON — mirroring the `task-status.mjs` script-test
// pattern (import the plain `.mjs` with a ts-expect-error, exercise its PURE parse function).
//
// The point is CLAUDE.md §2.11: a device lane whose parser rubber-stamps whatever it sees is a green
// that means nothing. Every red path below is a falsification of that parser.
import { describe, expect, test } from 'vitest';

// @ts-expect-error — plain .mjs CLI without type declarations (mirrors task-status.test.ts).
import * as driver from '../../../scripts/harness-device.mjs';

const RUN_ID = 'run-2026-07-21T05-00-00-abcdef';

interface Gate {
  id: string;
  kind: string;
  status: string;
  detail: string;
}
// variant/target are OPTIONAL so the "missing marker" tests can `delete` them.
interface Result {
  schema?: string;
  runId?: string;
  profile?: string;
  variant?: string;
  target?: string;
  hermesVersion?: string;
  gates: Gate[];
}

/** A well-formed EMULATOR correctness result: release variant, matching run id, every required gate
 * green. Every mutation below breaks exactly one property so the failure is attributable. */
function validResult(overrides: Partial<Result> = {}): Result {
  return {
    schema: 'bolusi-harness-result/1',
    runId: RUN_ID,
    profile: 'test',
    variant: 'release',
    target: 'emulator',
    hermesVersion: '0.17.0',
    gates: (driver.EMULATOR_REQUIRED_GATES as string[]).map((id: string) => ({
      id,
      kind: 'correctness',
      status: 'pass',
      detail: '',
    })),
    ...overrides,
  };
}

/** Wrap a result the way adb logcat presents it: a tagged line amid other noise. */
function logcat(result: Result, { tag = driver.HARNESS_RESULT_TAG as string } = {}): string {
  return [
    '07-21 05:00:00.000  1234  1234 I ReactNativeJS: booting harness',
    `07-21 05:00:01.500  1234  1234 I ${tag}: ${JSON.stringify(result)}`,
    '07-21 05:00:02.000  1234  1234 I ReactNativeJS: harness done',
  ].join('\n');
}

function parse(text: string, opts: Record<string, unknown> = {}) {
  return driver.parseHarnessResult(text, { expectedRunId: RUN_ID, ...opts });
}

describe('parseHarnessResult — the harness:device fail-safe', () => {
  test('accepts a release emulator run with a matching run id and every gate green', () => {
    const res = parse(logcat(validResult()));
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    // The whole point of the lane: figures are EMULATOR, never a device number (D12/D20).
    expect(res.result.target).toBe('emulator');
  });

  test('the required-gate set covers the 27a correctness gates', () => {
    // A pin on the denominator (T-14): the lane must demand the at-rest, JCS, and reduced-chaos
    // legs, so a shrunk gate set cannot pass by asking for less.
    expect(driver.EMULATOR_REQUIRED_GATES).toEqual(
      expect.arrayContaining([
        'SEC-DEV-06-at-rest',
        'SEC-AUTH-09-leg1',
        'SEC-OPLOG-06-jcs',
        'CHAOS-01',
        'CHAOS-03',
        'CHAOS-06',
        'CHAOS-07',
      ]),
    );
  });

  test('FAILS when any required gate is red', () => {
    const result = validResult();
    const [first] = result.gates;
    if (first === undefined) throw new Error('fixture has no gates');
    first.status = 'fail';
    first.detail = 'seeded marker leaked';
    const res = parse(logcat(result));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain(first.id);
  });

  test('FAILS when a required gate is absent from the capture (no partial pass)', () => {
    const result = validResult();
    result.gates = result.gates.filter((g) => g.id !== 'SEC-OPLOG-06-jcs');
    const res = parse(logcat(result));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('SEC-OPLOG-06-jcs');
  });

  test('FAILS a dev-mode build: variant is not release', () => {
    const res = parse(logcat(validResult({ variant: 'debug' })));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n').toLowerCase()).toContain('release');
  });

  test('FAILS when the release-variant marker is missing entirely', () => {
    const result = validResult();
    delete result.variant;
    const res = parse(logcat(result));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n').toLowerCase()).toContain('release');
  });

  test('FAILS a stale capture: the run id does not match this run (no reuse of a prior result)', () => {
    const stale = validResult({ runId: 'run-from-yesterday' });
    const res = parse(logcat(stale));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n').toLowerCase()).toContain('run id');
  });

  test('FAILS when no BOLUSI_HARNESS_RESULT line is present (the harness never emitted)', () => {
    const res = parse('07-21 05:00:00.000  1234 1234 I ReactNativeJS: booting\n(no result)');
    expect(res.ok).toBe(false);
    expect(res.result).toBeNull();
  });

  test('FAILS on unparseable JSON — a broken capture is NOT an empty pass (§2.1)', () => {
    const text = `07-21 05:00:01 I ${driver.HARNESS_RESULT_TAG}: {"schema":"bolusi-harness-result/1", TRUNCATED`;
    const res = parse(text);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n').toLowerCase()).toMatch(/pars|json/);
  });

  test('FAILS when the EMULATOR target label is missing (every figure must be labelled)', () => {
    const result = validResult();
    delete result.target;
    const res = parse(logcat(result));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n').toLowerCase()).toContain('target');
  });

  test('uses the LAST tagged line — the freshest capture, never an earlier stale one', () => {
    const stale = validResult({ runId: 'run-from-yesterday' });
    const fresh = validResult();
    const text = [logcat(stale), logcat(fresh)].join('\n');
    const res = parse(text);
    expect(res.ok).toBe(true);
    expect(res.result.runId).toBe(RUN_ID);
  });
});

// Task 176 — the OBSERVABILITY half. The lane's 20-minute red run (CI 29990800850) produced exactly
// one line of diagnosis because the launch check read only the exit status and every adb buffer was
// captured then discarded. These two pure functions are the parts of the fix that can be proven
// without an emulator; the adb orchestration around them is falsified against a stubbed `adb`.
describe('amStartFailureReason — `am start` exits 0 when it did not start anything', () => {
  // The verbatim shape real `am start` prints for a component that does not exist. The exit status
  // for this output is ZERO, which is precisely why reading it is the whole point (§2.11).
  const MISSING_COMPONENT = [
    'Starting: Intent { act=android.intent.action.MAIN cmp=com.bolusi.app/com.bolusi.app.HarnessActivity (has extras) }',
    'Error type 3',
    'Error: Activity class {com.bolusi.app/com.bolusi.app.HarnessActivity} does not exist.',
  ].join('\n');

  test('detects a missing component and names it, from stdout alone', () => {
    const reason = driver.amStartFailureReason(MISSING_COMPONENT) as string | null;
    expect(reason).not.toBeNull();
    // Names the component, so the reader knows WHICH activity is absent — not just "Error type 3".
    expect(reason).toContain('com.bolusi.app.HarnessActivity');
    expect(reason).toContain('does not exist');
  });

  test('a healthy cold launch is NOT a failure', () => {
    const ok = [
      'Starting: Intent { … }',
      'Status: ok',
      'LaunchState: COLD',
      'TotalTime: 1187',
      'Complete',
    ].join('\n');
    expect(driver.amStartFailureReason(ok)).toBeNull();
  });

  test('a WARM launch warning is NOT a failure — the check is positive evidence only', () => {
    // `am start` on an already-foregrounded activity warns and succeeds. Treating this as a failure
    // would make the driver red on a perfectly good launch, so the guard must stay silent here.
    const warm = [
      'Starting: Intent { … }',
      'Warning: Activity not started, its current task has been brought to the front',
      'Status: ok',
    ].join('\n');
    expect(driver.amStartFailureReason(warm)).toBeNull();
  });

  test('detects an explicit non-ok Status and a permission denial', () => {
    expect(driver.amStartFailureReason('Status: error')).toContain('Status: error');
    expect(
      driver.amStartFailureReason(
        'java.lang.SecurityException: Permission Denial: starting Intent',
      ),
    ).toContain('Permission Denial');
  });

  test('empty/absent output is not invented into a failure', () => {
    expect(driver.amStartFailureReason('')).toBeNull();
    expect(driver.amStartFailureReason(null)).toBeNull();
  });
});

describe('tailLines — the failure dump is bounded so one red run stays a readable log', () => {
  test('caps an oversized dump to the LAST maxLines and says how many it dropped', () => {
    const input = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = driver.tailLines(input, 400) as string;
    const lines = out.split('\n');
    // 400 kept + 1 elision marker. Unbounded, this would put 5000 lines into the job log.
    expect(lines).toHaveLength(401);
    expect(lines[0]).toContain('4600');
    // The TAIL, not the head — a crash and the give-up moment are at the END of the buffer.
    expect(lines[1]).toBe('line 4601');
    expect(lines[lines.length - 1]).toBe('line 5000');
  });

  test('leaves a dump that is already under the bound untouched (no spurious marker)', () => {
    const input = 'line 1\nline 2\nline 3';
    expect(driver.tailLines(input, 400)).toBe(input);
  });
});

// Task 198 step 4 — the CHAOS-03 net handshake the driver reads off the child server's stdout, and the
// `am start --es` argv it hands to the APK. The child prints `formatChaosNetHandshake`; the driver reads
// it back with `parseChaosNetHandshake` and forwards it with `chaosNetExtras`. All three are PURE, so the
// whole driver↔child wire is falsified here without a server or an emulator. `parseChaosNetHandshake` is
// the fail-safe twin of `parseHarnessResult`: a broken/absent handshake must be `null` (→ a non-zero lane
// exit), NEVER a net built from garbage that would read on-device as a server auth failure (§2.1).
describe('CHAOS-03 net handshake — the driver↔child wire (task 198)', () => {
  const HANDSHAKE = {
    port: 41234,
    baseUrl: 'http://127.0.0.1:41234',
    bearers: ['bdt_harness_aaa', 'bdt_harness_bbb', 'bdt_harness_ccc'],
  };

  test('format → parse round-trips the handshake exactly (the child and driver agree by construction)', () => {
    const line = driver.formatChaosNetHandshake(HANDSHAKE) as string;
    // The marker is present so the driver can find the line amid the child's other stdout.
    expect(line).toContain(driver.HARNESS_CHAOS_NET_HANDSHAKE_MARKER as string);
    expect(driver.parseChaosNetHandshake(line)).toEqual(HANDSHAKE);
  });

  test('parses the handshake even when the marker line is buried in other child stdout', () => {
    const text = [
      'harness-chaos-server: booting PGlite',
      driver.formatChaosNetHandshake(HANDSHAKE),
      'harness-chaos-server: listening',
    ].join('\n');
    expect(driver.parseChaosNetHandshake(text)).toEqual(HANDSHAKE);
  });

  test('chaosNetExtras yields the two --es triples the launch intent forwards to the APK', () => {
    // The EXACT argv the driver appends to `am start`: base URL under one key, bearers as a JSON string
    // of RAW tokens under the other. The device's parseChaosNet reads these two keys back (pinned equal
    // to contract.ts in apps/mobile/test/harness-producer.test.ts).
    expect(driver.chaosNetExtras(HANDSHAKE)).toEqual([
      '--es',
      driver.HARNESS_CHAOS_NET_BASE_URL_EXTRA,
      HANDSHAKE.baseUrl,
      '--es',
      driver.HARNESS_CHAOS_NET_BEARERS_EXTRA,
      JSON.stringify(HANDSHAKE.bearers),
    ]);
  });

  test('the LAST marker line wins — a stale earlier handshake can never mask a fresher one', () => {
    const stale = driver.formatChaosNetHandshake({
      ...HANDSHAKE,
      port: 1,
      baseUrl: 'http://127.0.0.1:1',
    });
    const fresh = driver.formatChaosNetHandshake(HANDSHAKE);
    expect(driver.parseChaosNetHandshake([stale, fresh].join('\n'))).toEqual(HANDSHAKE);
  });

  // ── FAIL-SAFE: every malformed handshake is `null`, never a partial net (§2.1) ────────────────────
  test('null when no marker line is present (the child never announced a server)', () => {
    expect(
      driver.parseChaosNetHandshake('harness-chaos-server: booting\n(no handshake)'),
    ).toBeNull();
  });

  test('null on unparseable JSON after the marker (a truncated line is not a net)', () => {
    const text = `${driver.HARNESS_CHAOS_NET_HANDSHAKE_MARKER}: {"port":41234,"baseUrl": TRUNCATED`;
    expect(driver.parseChaosNetHandshake(text)).toBeNull();
  });

  test('null on a non-integer or non-positive port', () => {
    for (const port of [1.5, 0, -3, '41234']) {
      const text = `${driver.HARNESS_CHAOS_NET_HANDSHAKE_MARKER}: ${JSON.stringify({ ...HANDSHAKE, port })}`;
      expect(driver.parseChaosNetHandshake(text), `port=${JSON.stringify(port)}`).toBeNull();
    }
  });

  test('null on an empty or non-string base URL', () => {
    for (const baseUrl of ['', 123, null]) {
      const text = `${driver.HARNESS_CHAOS_NET_HANDSHAKE_MARKER}: ${JSON.stringify({ ...HANDSHAKE, baseUrl })}`;
      expect(driver.parseChaosNetHandshake(text), `baseUrl=${JSON.stringify(baseUrl)}`).toBeNull();
    }
  });

  test('null when bearers is not a non-empty array of non-empty strings', () => {
    // A malformed bearers list must not build a net with blank/undefined Authorization headers (which
    // would read as a spurious server auth failure, not the honest "no net" that reds the lane).
    for (const bearers of [[], 'bdt_harness_aaa', [123], [''], ['bdt_harness_aaa', '']]) {
      const text = `${driver.HARNESS_CHAOS_NET_HANDSHAKE_MARKER}: ${JSON.stringify({ ...HANDSHAKE, bearers })}`;
      expect(driver.parseChaosNetHandshake(text), `bearers=${JSON.stringify(bearers)}`).toBeNull();
    }
  });
});
