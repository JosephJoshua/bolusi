import { describe, expect, test } from 'vitest';

import { classifyDbError, DbError, toDbError } from '../src/driver.js';

// The messages below are verbatim SQLite output captured from better-sqlite3 12.11.1;
// op-sqlite surfaces the same engine strings. Classification is what lets the
// conformance suite assert identical error behaviour on both adapters (testing-guide §2.3).
describe('classifyDbError maps native SQLite failures onto the portable code set', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['UNIQUE constraint failed: u.id', 'constraint'],
    ["CHECK constraint failed: source IN ('ui','agent','api','system')", 'constraint'],
    ['NOT NULL constraint failed: operations.hash', 'constraint'],
    ['FOREIGN KEY constraint failed', 'constraint'],
    ['no such table: nope', 'no_such_table'],
    ['near "SELCT": syntax error', 'syntax'],
    ['incomplete input', 'syntax'],
    ['attempt to write a readonly database', 'readonly'],
    ['file is not a database', 'not_a_database'],
    ['file is encrypted or is not a database', 'not_a_database'],
    ['disk I/O error', 'unknown'],
  ];

  for (const [message, expected] of cases) {
    test(`${message} → ${expected}`, () => {
      expect(classifyDbError(new Error(message))).toBe(expected);
    });
  }
});

test('classifyDbError reads the message through an adapter prefix', () => {
  // op-sqlite decorates some failures; matching is substring-based, not anchored.
  expect(classifyDbError(new Error('[op-sqlite] UNIQUE constraint failed: u.id'))).toBe(
    'constraint',
  );
});

test('classifyDbError tolerates non-Error throws', () => {
  expect(classifyDbError('no such table: t')).toBe('no_such_table');
  expect(classifyDbError(undefined)).toBe('unknown');
});

test('toDbError preserves the native error as cause and classifies it', () => {
  const native = new Error('UNIQUE constraint failed: u.id');
  const wrapped = toDbError(native);

  expect(wrapped).toBeInstanceOf(DbError);
  expect(wrapped.code).toBe('constraint');
  expect(wrapped.message).toBe('UNIQUE constraint failed: u.id');
  expect(wrapped.cause).toBe(native);
});

test('toDbError passes an already-classified DbError through unchanged', () => {
  const already = new DbError('constraint', 'UNIQUE constraint failed: u.id');
  expect(toDbError(already)).toBe(already);
});
