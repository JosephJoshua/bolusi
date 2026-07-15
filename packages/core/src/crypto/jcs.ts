// Guarded RFC 8785 (JCS) canonicalization — the hash preimage (05-operation-log §3).
//
// This module is the ONLY importer of `canonicalize` in the repo (08 §3.2). The same
// bytes must come out on Hermes and Node, hence the shared implementation and the
// two-runtime vector suite (SEC-OPLOG-06).
//
// WHY THE GUARD EXISTS — canonicalize@3.0.0 fails UNSAFELY on inputs that JavaScript
// makes easy to produce by accident. Verified against the pinned 3.0.0 source:
//
//   | input                    | canonicalize@3.0.0 emits | why that is dangerous          |
//   | ------------------------ | ------------------------ | ------------------------------ |
//   | `{ a: 1, b: undefined }` | `{"a":1}`                | SILENT key drop → wrong hash   |
//   | `[1, undefined, 2]`      | `[1,null,2]`             | silent coercion → wrong hash   |
//   | `{ a: Symbol() }`        | `{}`                     | silent key drop → wrong hash   |
//   | `{ a: 1, b(){} }`        | `{"a":1,"b":undefined}`  | INVALID JSON, hashed anyway    |
//   | `[1, function(){}]`      | `[1,]`                   | INVALID JSON, hashed anyway    |
//   | `undefined` (top level)  | `undefined` (not string) | not a string → unhashable      |
//   | `NaN` / `±Infinity`      | throws untyped `Error`   | indistinguishable from a bug   |
//   | `10n` (BigInt)           | throws raw `TypeError`   | indistinguishable from a bug   |
//
// A silently-dropped key is the worst outcome: two devices would hash *different*
// preimages and the mismatch would surface as BAD_SIGNATURE (05 §8) far from its
// cause. So every rejection below is a typed, located error raised BEFORE
// `canonicalize` ever sees the value — the guard never relies on the library to
// throw, and never lets it drop a key.
//
// Absent-vs-null (05 §3): explicit `null` is VALID and passes through untouched;
// `undefined` is not "absent", it is a bug — the signed core has no optional keys.
import canonicalize from 'canonicalize';

/** Every JSON value JCS accepts. `undefined` is deliberately absent. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Machine-readable reason a value cannot be canonicalized. */
export type JcsInputErrorCode =
  /** `undefined` — canonicalize would silently drop the key (05 §3 absent-vs-null). */
  | 'UNDEFINED_VALUE'
  /** `NaN`, `Infinity`, `-Infinity` — not representable in JSON (RFC 8785 §3.2.2.3). */
  | 'NON_FINITE_NUMBER'
  /** `BigInt` — JSON has no bigint; silently lossy if coerced. */
  | 'BIGINT_VALUE'
  /** `symbol` — canonicalize would silently drop the key. */
  | 'SYMBOL_VALUE'
  /** `function` — canonicalize would emit invalid JSON (`{"a":undefined}`). */
  | 'FUNCTION_VALUE'
  /**
   * An exotic object (Map, Set, Date, RegExp, Error, TypedArray, boxed primitive,
   * class instance...). The JSON data model has only objects and arrays; canonicalize
   * serializes anything else by its OWN ENUMERABLE KEYS, which for most of these is
   * none — so `new Set([1])` becomes `{}` and its contents vanish from the preimage.
   */
  | 'NON_PLAIN_OBJECT'
  /** A self-referencing structure. */
  | 'CIRCULAR_REFERENCE';

/**
 * A typed, located canonicalization rejection.
 *
 * Never thrown for legitimate data — every occurrence is a programming error at
 * `path`, which is why the path is part of the contract rather than a log line.
 */
export class JcsInputError extends Error {
  readonly code: JcsInputErrorCode;
  /** JSONPath-ish location of the offender, e.g. `$.payload.items[2].qty`. */
  readonly path: string;

  constructor(code: JcsInputErrorCode, path: string, detail: string) {
    super(`JCS input rejected at ${path}: ${detail} (${code})`);
    this.name = 'JcsInputError';
    this.code = code;
    this.path = path;
  }
}

function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return typeof value;
}

/**
 * Depth-first guard. Throws `JcsInputError` on the first offending value.
 *
 * `seen` tracks the ANCESTOR chain (not every visited node), so shared references
 * — the same object appearing twice as siblings — stay legal while true cycles are
 * caught. That mirrors what canonicalize itself considers circular.
 */
function assertCanonicalizable(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'undefined':
      throw new JcsInputError(
        'UNDEFINED_VALUE',
        path,
        'undefined would be silently dropped; the signed core has no optional keys — use explicit null',
      );
    case 'number':
      if (!Number.isFinite(value)) {
        throw new JcsInputError('NON_FINITE_NUMBER', path, `${describe(value)} is not valid JSON`);
      }
      return;
    case 'bigint':
      throw new JcsInputError('BIGINT_VALUE', path, 'BigInt is not representable in JSON');
    case 'symbol':
      throw new JcsInputError('SYMBOL_VALUE', path, 'symbol would be silently dropped');
    case 'function':
      throw new JcsInputError('FUNCTION_VALUE', path, 'a function would serialize to invalid JSON');
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new JcsInputError('CIRCULAR_REFERENCE', path, 'value refers to one of its own ancestors');
  }
  seen.add(object);

  if (Array.isArray(object)) {
    for (const [index, element] of object.entries()) {
      assertCanonicalizable(element, `${path}[${index}]`, seen);
    }
  } else {
    // WHITELIST, not blacklist. The JSON data model has exactly two container types:
    // arrays and plain objects. Everything else is rejected — enumerating "the exotic
    // types we happened to think of" is precisely how the Map/Set hole below survived
    // this guard's first version.
    //
    // canonicalize serializes any non-array object by its OWN ENUMERABLE keys, and most
    // exotic objects have none, so their contents silently vanish from the preimage:
    //   new Set([1])        -> {}          (contents gone)
    //   new Map([['a',1]])  -> {}          (contents gone)
    //   new Number(5)       -> {}          (value gone)
    //   new Uint8Array([1]) -> {"0":1}     (an object, not an array)
    // Two devices holding DIFFERENT Sets would hash to IDENTICAL bytes — a collision
    // across distinct data, strictly worse than the dropped-key bug this guard began as.
    //
    // The test is prototype-based so class instances are caught too (`[object Object]`
    // cannot distinguish them). Date is rejected deliberately: it serializes to an ISO
    // string, while the wire contract is integer ms-epoch and "never ISO strings"
    // (api/00 §2.1, 05 §3). Inherited `toJSON` (Date's lives on its prototype) is caught
    // here; the OWN-toJSON case is caught by the descriptor check below.
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (object as { constructor?: { name?: string } }).constructor?.name;
      throw new JcsInputError(
        'NON_PLAIN_OBJECT',
        path,
        `${name ?? 'exotic object'} is not JSON data — its contents would be silently dropped or reshaped; convert it to a plain object or array first`,
      );
    }

    // Reject an OWN `toJSON` FUNCTION, ENUMERABILITY BE DAMNED. This is a time-of-check /
    // time-of-use hole, not a type hole: canonicalize serializes any value whose `toJSON`
    // is a function by calling it (matching JSON.stringify), whether or not it is
    // enumerable — but `Object.keys` below only sees enumerable keys. So an object with a
    // non-enumerable own `toJSON` function reads as "plain" to a key walk while canonicalize
    // hashes whatever `toJSON()` RETURNS: the guard validates one value, the preimage is
    // another (`{amountIdr:250000}` and `{amountIdr:999999}`, each with a non-enumerable
    // toJSON returning `{}`, both canonicalize to `{}` — a collision across distinct data).
    // Only a descriptor probe sees a non-enumerable key.
    //
    // Precisely `typeof === 'function'`, matching canonicalize's OWN trigger, for two
    // reasons: (1) a `toJSON` DATA key is legitimate JSON — `{"toJSON":"note"}` arrives
    // straight from the wire via JSON.parse (enumerable string) and canonicalize emits it
    // verbatim; rejecting it would fail-closed on valid data. (2) We read the descriptor's
    // `value` rather than `object.toJSON` so an ACCESSOR (getter) toJSON is NOT invoked —
    // a getter is a separate, wire-unreachable TOCTOU deliberately left as accept.
    const toJsonDescriptor = Object.getOwnPropertyDescriptor(object, 'toJSON');
    if (toJsonDescriptor !== undefined && typeof toJsonDescriptor.value === 'function') {
      throw new JcsInputError(
        'NON_PLAIN_OBJECT',
        path,
        'object defines an own toJSON function — canonicalize would hash its return value, not the object the guard validated',
      );
    }

    // Own enumerable keys only — exactly the set canonicalize serializes.
    for (const key of Object.keys(object)) {
      assertCanonicalizable((object as Record<string, unknown>)[key], `${path}.${key}`, seen);
    }
  }

  seen.delete(object);
}

/**
 * Canonicalize a JSON value to its RFC 8785 string form.
 *
 * @throws {JcsInputError} on any value JCS cannot represent — never a silent drop.
 */
export function canonicalizeJcs(value: JsonValue): string {
  assertCanonicalizable(value, '$', new Set());

  const result = canonicalize(value);

  /* c8 ignore start -- unreachable: the guard above rejects every input for which
     canonicalize@3 returns undefined. Kept as a fail-closed backstop so a future
     version bump can never turn `undefined` into a hashed preimage. */
  if (typeof result !== 'string') {
    throw new JcsInputError('UNDEFINED_VALUE', '$', 'canonicalize returned a non-string');
  }
  /* c8 ignore stop */

  return result;
}
