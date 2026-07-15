// The CI lane of the driver-conformance suite (testing-guide §2.3).
//
// The suite itself lives in @bolusi/test-support and imports no driver; the driver is
// injected here. This file runs it against better-sqlite3. Task 27 runs the SAME suite
// against op-sqlite on the reference device via `@bolusi/db-client/op-sqlite`; identical
// results across the two lanes are what license "green in CI ⇒ meaningful on device".
import { expect, test } from 'vitest';
import { DRIVER_CONFORMANCE_CASES, runDriverConformance } from '@bolusi/test-support';

import { openTestDriver } from './better-sqlite3-adapter.js';

test('driver conformance: better-sqlite3 in-memory lane passes every case', async () => {
  const results = await runDriverConformance(openTestDriver);

  // Report the detail, not just a count — a bare boolean makes a red run undiagnosable.
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(results.map((result) => result.case)).toEqual(
    DRIVER_CONFORMANCE_CASES.map((testCase) => testCase.name),
  );
});

test('the suite reports failures rather than swallowing them', async () => {
  // Guards the harness itself: a suite that returns "all passed" for a broken driver
  // would make every future CI run meaningless. Task 27's device lane trusts this.
  const brokenDriver = () =>
    Promise.resolve({
      execute: () => Promise.reject(new Error('driver is broken')),
      executeBatch: () => Promise.reject(new Error('driver is broken')),
      prepare: () => {
        throw new Error('driver is broken');
      },
      begin: () => Promise.reject(new Error('driver is broken')),
      commit: () => Promise.reject(new Error('driver is broken')),
      rollback: () => Promise.reject(new Error('driver is broken')),
      close: () => Promise.resolve(),
    });

  const results = await runDriverConformance(brokenDriver);

  expect(results.every((result) => !result.passed)).toBe(true);
  expect(results.every((result) => (result.detail ?? '').length > 0)).toBe(true);
});
