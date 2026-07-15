// Query cursor codec (04-module-contract §6).
//
// The contract: a malformed / tampered / stale cursor is a typed `DomainError('VALIDATION_FAILED')`
// — never an unhandled throw, and never a silent restart from page one. Silent restart is the
// dangerous one: it turns a client's page-walk into an infinite loop re-delivering page one while
// looking perfectly healthy.
//
// T-12 (test the CLASS, not remembered instances): the tamper cases below are enumerated by the
// LAYER they corrupt — base64 alphabet, base64 padding, UTF-8, JSON, cursor shape, field types,
// numeric domain — because each layer throws a different native error type and a codec that
// forgot to catch one of them would leak a `RangeError`/`SyntaxError` past the query runtime.
import { describe, expect, test } from 'vitest';

import {
  bytesToBase64,
  decodeCursor,
  DomainError,
  encodeCursor,
  utf8ToBytes,
} from '../../src/index.js';

/** Assert a cursor is rejected as VALIDATION_FAILED — and NOT via some other error class. */
function expectRejected(cursor: string, sort = 'createdAt.desc'): DomainError {
  let error: unknown;
  try {
    decodeCursor(cursor, sort);
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof DomainError)) {
    // The whole point: a RangeError from the base64 codec or a SyntaxError from JSON escaping to
    // the caller IS the bug. Naming it here beats a bare `toThrow()`.
    throw new Error(`expected DomainError, got ${String(error)}`);
  }
  expect(error.code).toBe('VALIDATION_FAILED');
  return error;
}

describe('round-trip', () => {
  test('decodes a cursor it encoded', () => {
    const position = { sort: 'createdAt.desc', values: [1_726_000_111_000, 'item-a1'] as const };

    const decoded = decodeCursor(encodeCursor(position), 'createdAt.desc');

    expect(decoded.sort).toBe('createdAt.desc');
    expect(decoded.values).toEqual([1_726_000_111_000, 'item-a1']);
  });

  test('is opaque — the encoding is not the raw sort key', () => {
    // Not a security property (a cursor carries no authority — see cursor.ts), but a compatibility
    // one: a client that reverse-engineered the format would couple itself to it, and the format is
    // versioned precisely so it can change.
    const cursor = encodeCursor({ sort: 'createdAt.asc', values: [42, 'plainly-visible-id'] });

    expect(cursor).not.toContain('plainly-visible-id');
  });
});

describe('tampered and malformed cursors → VALIDATION_FAILED (the class, by layer)', () => {
  test('rejects an empty cursor', () => {
    expectRejected('');
  });

  test('rejects a non-base64 alphabet', () => {
    // Layer: base64 alphabet. `base64ToBytes` throws RangeError; the codec must convert it.
    expectRejected('!!!not-base64!!!');
  });

  test('rejects base64 with a bad length', () => {
    // Layer: base64 length (not a multiple of 4).
    expectRejected('abcde');
  });

  test('rejects non-canonical base64 padding', () => {
    // Layer: base64 padding placement. This repo's `base64ToBytes` is deliberately strict about
    // `AA=A`-shaped input (see crypto/bytes.ts) — T-13's own example. A lenient decoder would
    // accept it and produce a *different* cursor that still parsed.
    expectRejected('AA=A');
  });

  test('rejects valid base64 that is not valid UTF-8', () => {
    // Layer: UTF-8. 0xFF is a byte no UTF-8 encoding produces.
    expectRejected(bytesToBase64(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])));
  });

  test('rejects valid UTF-8 that is not JSON', () => {
    // Layer: JSON. `JSON.parse` throws SyntaxError.
    expectRejected(bytesToBase64(utf8ToBytes('this is not json at all')));
  });

  test('rejects JSON that is not an object', () => {
    // Layer: cursor shape. `[1,2]` and `"x"` parse fine and are not cursors.
    expectRejected(bytesToBase64(utf8ToBytes('[1,2]')));
  });

  test('rejects a cursor object with an unknown version', () => {
    // Layer: format version. This is how a future cursor-shape change retires old cursors cleanly
    // instead of misreading them.
    expectRejected(
      bytesToBase64(utf8ToBytes(JSON.stringify({ v: 999, s: 'createdAt.desc', k: [1, 'a'] }))),
    );
  });

  test('rejects a cursor with a missing sort key', () => {
    expectRejected(
      bytesToBase64(utf8ToBytes(JSON.stringify({ v: 1, s: 'createdAt.desc', k: [] }))),
    );
  });

  test('rejects a sort key containing a non-scalar', () => {
    // Layer: field types. An object in the key would reach the SQL builder as a parameter.
    expectRejected(
      bytesToBase64(
        utf8ToBytes(JSON.stringify({ v: 1, s: 'createdAt.desc', k: [{ evil: true }, 'a'] })),
      ),
    );
  });

  test('rejects a sort key containing a non-finite number', () => {
    // Layer: numeric domain. `Infinity` JSON-serializes to `null`, so seeing one back means the
    // cursor was hand-edited — and it would compare false against every row, returning an empty
    // page that reads as a legitimate end-of-list.
    expectRejected(bytesToBase64(utf8ToBytes('{"v":1,"s":"createdAt.desc","k":[1e999,"a"]}')));
  });

  test('rejects a cursor issued for a DIFFERENT sort', () => {
    // Staleness, not corruption: the cursor is perfectly well-formed and belongs to another walk.
    // Re-interpreting it against a reversed order silently skips rows.
    const cursor = encodeCursor({ sort: 'createdAt.asc', values: [5, 'b'] });

    expectRejected(cursor, 'createdAt.desc');
  });

  test('a tampered cursor NEVER decodes to a valid position (no silent restart)', () => {
    // The failure mode this whole file exists for. `decodeCursor` has no fallback path: it either
    // returns the position that was encoded, or it throws. If it silently returned page one, this
    // test would be the only thing that noticed.
    const genuine = encodeCursor({
      sort: 'createdAt.desc',
      values: [1_726_000_222_000, 'item-b2'],
    });
    const tampered = `${genuine.slice(0, -4)}AAAA`;

    let decoded: unknown;
    try {
      decoded = decodeCursor(tampered, 'createdAt.desc');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return;
    }
    // If it DID decode (the last 4 chars happened to be valid), it must at least not have become a
    // different-but-plausible position that would silently skip rows.
    expect(decoded).toEqual({ sort: 'createdAt.desc', values: [1_726_000_222_000, 'item-b2'] });
  });
});
