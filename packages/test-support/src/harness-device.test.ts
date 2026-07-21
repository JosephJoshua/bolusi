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
