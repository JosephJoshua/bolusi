// JCS input guards (05-operation-log §3; 08 §2.3 "Guard inputs against
// undefined/BigInt/NaN/Infinity").
//
// These tests exist because canonicalize@3.0.0 fails UNSAFELY, not loudly: the pinned
// source silently drops `undefined`/symbol-valued keys and emits invalid JSON for
// function values. Each case below therefore asserts the LIBRARY's raw behaviour first
// (documenting exactly what we are protecting against, and failing loudly if a future
// pin changes it) and then asserts our wrapper's typed rejection.
import canonicalize from 'canonicalize';
import { canonicalizeJcs, JcsInputError } from '@bolusi/core';
import { describe, expect, it } from 'vitest';

/** Canonicalize and return the JcsInputError, or fail if none was thrown. */
function expectRejection(value: unknown): JcsInputError {
  try {
    canonicalizeJcs(value as Parameters<typeof canonicalizeJcs>[0]);
  } catch (error) {
    expect(error).toBeInstanceOf(JcsInputError);
    return error as JcsInputError;
  }
  throw new Error('expected canonicalizeJcs to throw, but it returned');
}

describe('canonicalizeJcs — input guards', () => {
  describe('undefined (05 §3 absent-vs-null)', () => {
    it('rejects a top-level undefined', () => {
      const error = expectRejection(undefined);
      expect(error.code).toBe('UNDEFINED_VALUE');
      expect(error.path).toBe('$');
    });

    it('rejects an undefined value rather than dropping the key', () => {
      // The library's actual behaviour — a SILENT key drop, i.e. a different hash
      // preimage with no error anywhere.
      expect(canonicalize({ keep: 1, lost: undefined })).toBe('{"keep":1}');

      const error = expectRejection({ keep: 1, lost: undefined });
      expect(error.code).toBe('UNDEFINED_VALUE');
      expect(error.path).toBe('$.lost');
    });

    it('rejects a nested undefined value and reports its path', () => {
      expect(canonicalize({ outer: { inner: { gone: undefined } } })).toBe(
        '{"outer":{"inner":{}}}',
      );

      const error = expectRejection({ outer: { inner: { gone: undefined } } });
      expect(error.code).toBe('UNDEFINED_VALUE');
      expect(error.path).toBe('$.outer.inner.gone');
    });

    it('rejects an undefined array element rather than coercing it to null', () => {
      // Silent coercion: the array LENGTH survives but the value becomes null.
      expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');

      const error = expectRejection([1, undefined, 3]);
      expect(error.code).toBe('UNDEFINED_VALUE');
      expect(error.path).toBe('$[1]');
    });

    it('accepts an explicit null — nullable core fields are always present-and-null', () => {
      expect(canonicalizeJcs({ storeId: null, location: null })).toBe(
        '{"location":null,"storeId":null}',
      );
    });
  });

  describe('non-finite numbers', () => {
    it.each([
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('rejects %s with a typed error', (_label, value) => {
      const error = expectRejection({ amount: value });
      expect(error.code).toBe('NON_FINITE_NUMBER');
      expect(error.path).toBe('$.amount');
    });

    it('rejects a non-finite number nested in an array', () => {
      const error = expectRejection({ readings: [1, Number.NaN] });
      expect(error.code).toBe('NON_FINITE_NUMBER');
      expect(error.path).toBe('$.readings[1]');
    });

    it("rejects with JcsInputError, not the library's untyped Error", () => {
      // canonicalize throws a bare Error for NaN — indistinguishable from an internal
      // bug by a catch block. Ours is typed and located.
      expect(() => canonicalize(Number.NaN)).toThrow(Error);
      const error = expectRejection(Number.NaN);
      expect(error.name).toBe('JcsInputError');
      expect(error.code).toBe('NON_FINITE_NUMBER');
    });
  });

  describe('types JSON cannot represent', () => {
    it('rejects a BigInt', () => {
      const error = expectRejection({ total: 10n });
      expect(error.code).toBe('BIGINT_VALUE');
      expect(error.path).toBe('$.total');
    });

    it('rejects a symbol rather than dropping the key', () => {
      expect(canonicalize({ keep: 1, marker: Symbol('x') })).toBe('{"keep":1}');

      const error = expectRejection({ keep: 1, marker: Symbol('x') });
      expect(error.code).toBe('SYMBOL_VALUE');
      expect(error.path).toBe('$.marker');
    });

    it('rejects a function rather than emitting invalid JSON', () => {
      // The worst library behaviour of all: not a drop but a syntactically INVALID
      // preimage, which would be hashed and signed without complaint.
      expect(canonicalize({ keep: 1, fn: () => 1 })).toBe('{"fn":undefined,"keep":1}');

      const error = expectRejection({ keep: 1, fn: () => 1 });
      expect(error.code).toBe('FUNCTION_VALUE');
      expect(error.path).toBe('$.fn');
    });

    it('rejects a function inside an array', () => {
      expect(canonicalize([1, () => 1])).toBe('[1,]');

      const error = expectRejection([1, () => 1]);
      expect(error.code).toBe('FUNCTION_VALUE');
      expect(error.path).toBe('$[1]');
    });
  });

  describe('structure', () => {
    it('rejects a circular reference', () => {
      const node: Record<string, unknown> = { name: 'root' };
      node['self'] = node;

      const error = expectRejection(node);
      expect(error.code).toBe('CIRCULAR_REFERENCE');
      expect(error.path).toBe('$.self');
    });

    it('accepts the same object appearing twice as a sibling (a DAG is not a cycle)', () => {
      const shared = { unit: 'kg' };
      expect(canonicalizeJcs({ a: shared, b: shared })).toBe(
        '{"a":{"unit":"kg"},"b":{"unit":"kg"}}',
      );
    });

    it('reports only the first offender when several are present', () => {
      const error = expectRejection({ a: undefined, b: Number.NaN });
      expect(error.code).toBe('UNDEFINED_VALUE');
    });
  });

  describe('canonical output', () => {
    it('sorts keys and leaves array order alone', () => {
      expect(canonicalizeJcs({ b: [3, 1, 2], a: 1 })).toBe('{"a":1,"b":[3,1,2]}');
    });

    it('serializes -0 as 0 (RFC 8785 Appendix B)', () => {
      expect(canonicalizeJcs({ v: -0 })).toBe('{"v":0}');
    });
  });
});
