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

// The SUCCESS-path artifact echo (`formatResultArtifactLine`). A GREEN emulator run must surface the
// device's exact result JSON on the driver's OWN stdout, so a SEC-AUTH-09 re-anchor can harvest the
// buildSha-stamped at-rest artifact from the job log — until this, only the FAILURE path dumped the
// payload and a passing run tore the emulator (and its logcat buffer) down with the only copy. The
// load-bearing invariant is that the SAME parser recovers the echoed line byte-for-byte: one
// serialization, no drift. These are pure, so the whole harvest wire is proven without an emulator.
describe('formatResultArtifactLine — the success-path artifact echo (SEC-AUTH-09 harvest)', () => {
  // A realistic single-line result JSON as adb logcat presents it: buildSha-stamped (task 182), which
  // is the field the SEC-AUTH-09 provenance gate reads — an artifact that fails to carry it is red.
  const PAYLOAD = JSON.stringify({
    schema: 'bolusi-harness-result/1',
    runId: RUN_ID,
    variant: 'release',
    target: 'emulator',
    buildSha: 'dabdaafc72bc298746c0bcdc13e9d805bffcdf72',
    gates: [{ id: 'SEC-DEV-06-at-rest', kind: 'correctness', status: 'pass', detail: '' }],
  });

  test('round-trips through extractResultPayload byte-for-byte (one parser, no second format)', () => {
    const line = driver.formatResultArtifactLine(PAYLOAD) as string;
    // The marker is present so a harvester can find the line amid the driver's other stdout.
    expect(line).toContain(driver.HARNESS_RESULT_TAG as string);
    expect(driver.extractResultPayload(line)).toBe(PAYLOAD);
  });

  test('the harvested artifact JSON-parses back to the buildSha the re-anchor needs', () => {
    const recovered = driver.extractResultPayload(
      driver.formatResultArtifactLine(PAYLOAD),
    ) as string;
    const parsed = JSON.parse(recovered) as { buildSha?: string; target?: string };
    // Not just any string survives — the exact stamped commit does, so the harvest is USABLE, not
    // merely non-empty (§2.11: a harvest that dropped the buildSha would be a silent no-op).
    expect(parsed.buildSha).toBe('dabdaafc72bc298746c0bcdc13e9d805bffcdf72');
    expect(parsed.target).toBe('emulator');
  });

  test('recovers the payload even when the echoed line is buried in other driver stdout', () => {
    // The real success path prints a human summary line right before the artifact line; the harvest
    // must still pull the payload out of the surrounding console noise.
    const stdout = [
      'harness:device: EMULATOR correctness gates PASS (7 gates, target=emulator, hermes=0.17.0).',
      driver.formatResultArtifactLine(PAYLOAD),
      'harness:device: done',
    ].join('\n');
    expect(driver.extractResultPayload(stdout)).toBe(PAYLOAD);
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

// Task 198 step 4 — the CHAOS-03/06/07 net handshake the driver reads off the child server's stdout, and
// the `am start --es` argv it hands to the APK. The child prints ONE `formatChaosNetHandshake` line
// covering all three scenarios; the driver reads it back with `parseChaosNetHandshake` and forwards it
// with `chaosNetExtras`. All three are PURE, so the whole driver↔child wire is falsified here without a
// server or an emulator. `parseChaosNetHandshake` is the fail-safe twin of `parseHarnessResult`: a
// broken/absent handshake — or ANY one of the three scenarios malformed — must be `null` (→ a non-zero
// lane exit), NEVER a net built from garbage that would read on-device as a server auth failure (§2.1).
describe('CHAOS-03/06/07 net handshake — the driver↔child wire (task 198)', () => {
  const MARKER = driver.HARNESS_CHAOS_NET_HANDSHAKE_MARKER as string;

  /** A valid three-scenario handoff: distinct port/baseUrl/bearers per scenario, so a field crossed
   * between scenarios (or a shared port) would be caught. */
  const HANDSHAKE = {
    scenarios: {
      chaos03: {
        port: 41234,
        baseUrl: 'http://127.0.0.1:41234',
        bearers: ['bdt_harness_a0', 'bdt_harness_a1'],
      },
      chaos06: {
        port: 41235,
        baseUrl: 'http://127.0.0.1:41235',
        bearers: ['bdt_harness_b0', 'bdt_harness_b1', 'bdt_harness_b2'],
      },
      chaos07: {
        port: 41236,
        baseUrl: 'http://127.0.0.1:41236',
        bearers: ['bdt_harness_c0', 'bdt_harness_c1'],
      },
    },
  };

  /** Render a handshake-shaped object into the child's one marker line. */
  function markerLine(obj: unknown): string {
    return `${MARKER}: ${JSON.stringify(obj)}`;
  }

  /** Clone HANDSHAKE with ONE scenario replaced by `entry` (undefined ⇒ that scenario is absent). */
  function withScenario(id: string, entry: unknown): unknown {
    const scenarios: Record<string, unknown> = { ...HANDSHAKE.scenarios };
    if (entry === undefined) delete scenarios[id];
    else scenarios[id] = entry;
    return { scenarios };
  }

  test('format → parse round-trips every scenario exactly (the child and driver agree by construction)', () => {
    const line = driver.formatChaosNetHandshake(HANDSHAKE) as string;
    // The marker is present so the driver can find the line amid the child's other stdout.
    expect(line).toContain(MARKER);
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

  test('chaosNetExtras yields the ONE --es triple the launch intent forwards to the APK', () => {
    // The EXACT argv the driver appends to `am start`: a single fixed-width extra whose value is the
    // per-scenario JSON map of {baseUrl, bearers} — RAW tokens, the port dropped (the device reaches the
    // reversed port via the base URL, it never needs the number). The value is SINGLE-QUOTED so the
    // device shell (mksh) forwards it to `am` verbatim instead of brace-expanding the bare `{…}` (see
    // chaosNetExtras; the survives-a-real-shell proof is the wire test in harness-producer.test.ts). The
    // device's parseChaosNet reads this ONE key back (pinned equal to contract.ts in that same file).
    const { chaos03, chaos06, chaos07 } = HANDSHAKE.scenarios;
    const json = JSON.stringify({
      chaos03: { baseUrl: chaos03.baseUrl, bearers: chaos03.bearers },
      chaos06: { baseUrl: chaos06.baseUrl, bearers: chaos06.bearers },
      chaos07: { baseUrl: chaos07.baseUrl, bearers: chaos07.bearers },
    });
    expect(driver.chaosNetExtras(HANDSHAKE)).toEqual([
      '--es',
      driver.HARNESS_CHAOS_NET_EXTRA,
      `'${json}'`,
    ]);
  });

  test('the LAST marker line wins — a stale earlier handshake can never mask a fresher one', () => {
    const stale = driver.formatChaosNetHandshake(
      withScenario('chaos03', {
        port: 1,
        baseUrl: 'http://127.0.0.1:1',
        bearers: ['bdt_harness_stale'],
      }),
    );
    const fresh = driver.formatChaosNetHandshake(HANDSHAKE);
    expect(driver.parseChaosNetHandshake([stale, fresh].join('\n'))).toEqual(HANDSHAKE);
  });

  // ── FAIL-SAFE: every malformed handshake is `null`, never a partial net (§2.1) ────────────────────
  test('null when no marker line is present (the child never announced its servers)', () => {
    expect(
      driver.parseChaosNetHandshake('harness-chaos-server: booting\n(no handshake)'),
    ).toBeNull();
  });

  test('null on unparseable JSON after the marker (a truncated line is not a net)', () => {
    expect(driver.parseChaosNetHandshake(`${MARKER}: {"scenarios": TRUNCATED`)).toBeNull();
  });

  test('null when the scenarios object is missing or is not an object', () => {
    for (const bad of [{}, { scenarios: null }, { scenarios: 'nope' }, { scenarios: 42 }]) {
      expect(driver.parseChaosNetHandshake(markerLine(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  test('null when ANY one scenario is absent — all three must validate or the whole handshake is null', () => {
    for (const id of ['chaos03', 'chaos06', 'chaos07']) {
      expect(
        driver.parseChaosNetHandshake(markerLine(withScenario(id, undefined))),
        `missing ${id}`,
      ).toBeNull();
    }
  });

  test('null on a non-integer or non-positive port (checked per scenario)', () => {
    for (const port of [1.5, 0, -3, '41234']) {
      const text = markerLine(withScenario('chaos06', { ...HANDSHAKE.scenarios.chaos06, port }));
      expect(driver.parseChaosNetHandshake(text), `port=${JSON.stringify(port)}`).toBeNull();
    }
  });

  test('null on an empty or non-string base URL (checked per scenario)', () => {
    for (const baseUrl of ['', 123, null]) {
      const text = markerLine(withScenario('chaos07', { ...HANDSHAKE.scenarios.chaos07, baseUrl }));
      expect(driver.parseChaosNetHandshake(text), `baseUrl=${JSON.stringify(baseUrl)}`).toBeNull();
    }
  });

  test('null when a scenario bearers is not a non-empty array of non-empty strings', () => {
    // A malformed bearers list must not build a net with blank/undefined Authorization headers (which
    // would read as a spurious server auth failure, not the honest "no net" that reds the lane).
    for (const bearers of [[], 'bdt_harness_aaa', [123], [''], ['bdt_harness_aaa', '']]) {
      const text = markerLine(withScenario('chaos03', { ...HANDSHAKE.scenarios.chaos03, bearers }));
      expect(driver.parseChaosNetHandshake(text), `bearers=${JSON.stringify(bearers)}`).toBeNull();
    }
  });
});
