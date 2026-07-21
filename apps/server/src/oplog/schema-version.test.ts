// Unit falsification of the push-time schemaVersion gate (task 121; 05 §7/§8, 04 §3). The predicate
// is what makes a bogus-version op rejected at push instead of accepted-then-thrown-at-fold, so it is
// pinned directly: the whole class of bug lives in the boundary between "current" and "> current".
import { describe, expect, test } from 'vitest';

import { isFoldableSchemaVersion } from './schema-version.js';

describe('isFoldableSchemaVersion — foldable ⟺ integer in 1..current (05 §7)', () => {
  test('the CURRENT version is foldable (the freshly-emitted op, 04 §3)', () => {
    expect(isFoldableSchemaVersion(3, 3)).toBe(true);
    expect(isFoldableSchemaVersion(1, 1)).toBe(true);
  });

  test('an OLD version below current is foldable (a rolling-out v2 while the server is at v3)', () => {
    // The nuance: the applier folds v1/v2/v3 forever (05 §7); the gate must not reject a legit v1/v2.
    expect(isFoldableSchemaVersion(3, 1)).toBe(true);
    expect(isFoldableSchemaVersion(3, 2)).toBe(true);
  });

  test('a version ABOVE current is NOT foldable — never declared, no applier (the task-121 hole)', () => {
    expect(isFoldableSchemaVersion(3, 4)).toBe(false);
    expect(isFoldableSchemaVersion(3, 99)).toBe(false);
    expect(isFoldableSchemaVersion(1, 2)).toBe(false);
  });

  test('a version below 1 is NOT foldable — not a valid envelope version (05 §2.1: integer ≥ 1)', () => {
    expect(isFoldableSchemaVersion(3, 0)).toBe(false);
    expect(isFoldableSchemaVersion(3, -1)).toBe(false);
  });

  test('a non-integer version is NOT foldable (05 §3: schemaVersion is an integer)', () => {
    expect(isFoldableSchemaVersion(3, 2.5)).toBe(false);
    expect(isFoldableSchemaVersion(3, Number.NaN)).toBe(false);
    expect(isFoldableSchemaVersion(3, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
