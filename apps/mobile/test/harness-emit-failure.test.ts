// The emit-failure path must be LOUD, never a silent swallow (task 175 review, §2.11 — the
// catch-that-hid-the-missing-producer class). Native `Log.i` under the driver's tag is the ONLY channel
// the tag-filtered poll can read; if the `HarnessNative` module is not in the build (e.g. its source was
// not committed — the exact bug this review caught), `requireNativeModule('HarnessNative')` throws, and
// the harness must surface a DISTINCT marker into the unfiltered logcat rather than produce nothing.
//
// Only the NATIVE boundary is mocked (`requireNativeModule`); everything asserted here — the try/catch,
// the marker, the rethrow, the tag the happy path writes under — is emit.ts's REAL code. (The full
// import cannot pull the real `expo` under vitest: it references Metro's `__DEV__` global.)
import { beforeEach, describe, expect, test, vi } from 'vitest';

const requireNativeModule = vi.hoisted(() => vi.fn());
vi.mock('expo', () => ({ requireNativeModule }));

import { HARNESS_EMIT_FAILED_MARKER, emitHarnessResult } from '../src/harness/emit.js';
import { HARNESS_RESULT_SCHEMA, HARNESS_RESULT_TAG } from '../src/harness/flag.js';
import type { HarnessResult } from '../src/harness/result.js';

const result: HarnessResult = {
  schema: HARNESS_RESULT_SCHEMA,
  runId: 'run-emit-failure-probe',
  profile: 'test',
  variant: 'release',
  target: 'emulator',
  hermesVersion: '0.17.0',
  buildSha: '1111111111111111111111111111111111111111',
  gates: [],
};

describe('emitHarnessResult — the native emitter is load-bearing (§2.11)', () => {
  beforeEach(() => {
    requireNativeModule.mockReset();
  });

  test('MISSING native module → logs the distinct marker AND rethrows (never silent nothing)', () => {
    // The exact bug this review caught: the module never compiled into the build, so requireNativeModule
    // throws. The harness must NOT swallow it into nothing.
    requireNativeModule.mockImplementation(() => {
      throw new Error("Cannot find native module 'HarnessNative'");
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => {
      emitHarnessResult(result);
    }).toThrow(/HarnessNative/);
    const logged = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(HARNESS_EMIT_FAILED_MARKER);
    spy.mockRestore();
  });

  test('POSITIVE CONTROL — native present → writes under the DRIVER tag, no marker, no throw', () => {
    const logResult = vi.fn<(tag: string, message: string) => number>().mockReturnValue(42);
    requireNativeModule.mockReturnValue({ logResult });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => {
      emitHarnessResult(result);
    }).not.toThrow();
    // Emitted under EXACTLY the tag the driver's `-s BOLUSI_HARNESS_RESULT:I` poll filters on.
    expect(logResult).toHaveBeenCalledWith(HARNESS_RESULT_TAG, expect.stringContaining('"schema"'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
