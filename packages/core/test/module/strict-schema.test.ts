// INTERROGATING THE ORACLE (testing-guide T-13) for `defineModule`'s `.strict()` check.
//
// `isStrictSchema` probes behaviour rather than reading zod's internals, because @bolusi/core may
// not import zod (08 §3.3). That makes the probe's correctness a claim ABOUT ZOD — specifically:
// "a strict object reports an `unrecognized_keys` issue naming the probe key, even when required
// fields are missing; a stripping or passthrough object does not". If that claim is false, 04 §3's
// most consequential validation silently passes everything.
//
// So this suite drives REAL ZOD. zod is a devDependency of @bolusi/core, test-only — the same shape
// as better-sqlite3 (which the `bolusi/boundaries` rule permits for `packages/core` under
// `testOnly`, and which core's projection tests already use). Shipping core imports neither; the
// package's `dependencies` still list only schemas/canonicalize/kysely, and the shipping-deps test
// enforces that.
//
// T-13 is the whole point: verifying this probe against `packages/test-support`'s hand-rolled
// `strictParser` would be verifying the imitation. The fixture's parser is written to mirror zod's
// issue shape; THIS file is what makes that mirroring true rather than intended.
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { isStrictSchema, STRICTNESS_PROBE_KEY } from '../../src/index.js';

describe('isStrictSchema against real zod (T-13 — the probe is verified against the article)', () => {
  test('accepts z.strictObject with required fields', () => {
    // The 04 §3 shape: `z.strictObject({...})` is what every payload schema is.
    const schema = z.strictObject({ title: z.string().min(1), amountIdr: z.number().int() });

    expect(isStrictSchema(schema)).toBe(true);
  });

  test('accepts z.object(...).strict() — the form 04 §3 spells out', () => {
    // 04 §3's literal example writes `.strict()` rather than `strictObject`. Both must pass, or the
    // doc's own example would fail its own validator.
    const schema = z.object({ body: z.string() }).strict();

    expect(isStrictSchema(schema)).toBe(true);
  });

  test('rejects z.object — zod STRIPS unknown keys by default, which is not strict', () => {
    // The important negative: the default is not `.strict()`, it silently drops unknown keys. A
    // client would believe it recorded a field the append-only log does not contain.
    const schema = z.object({ label: z.string() });

    expect(isStrictSchema(schema)).toBe(false);
  });

  test('rejects z.looseObject — passthrough keeps unknown keys', () => {
    const schema = z.looseObject({ note: z.string() });

    expect(isStrictSchema(schema)).toBe(false);
  });

  test('accepts a strict object with NO required fields', () => {
    // The probe's only signal here is the unrecognized-keys issue: there are no missing-field
    // issues to accompany it. If the probe depended on parse failing for some other reason, this
    // is where that would show.
    const schema = z.strictObject({});

    expect(isStrictSchema(schema)).toBe(true);
  });

  test('accepts a strict object wrapped in .refine()', () => {
    // A refinement wraps the object in another schema. The probe is behavioural, so it sees through
    // the wrapper — an introspection-based check reading `_zod.def.catchall` would not.
    const schema = z
      .strictObject({ quantity: z.number().int() })
      .refine((value) => value.quantity > 0, 'must be positive');

    expect(isStrictSchema(schema)).toBe(true);
  });

  test('rejects a non-object schema', () => {
    // A payload must be an object (04 §3). A string schema reports `invalid_type` and no
    // unrecognized-keys issue, so it fails closed.
    const schema = z.string();

    expect(isStrictSchema(schema)).toBe(false);
  });

  test('THE LOAD-BEARING ZOD BEHAVIOUR: unrecognized_keys is reported ALONGSIDE missing-field errors', () => {
    // This is the assumption the whole probe rests on, asserted directly against zod rather than
    // inferred from the probe passing. If zod ever short-circuited on the first missing field, the
    // probe would report every strict schema as non-strict — a loud, fail-closed break that this
    // test names precisely, instead of a mysterious mass startup failure.
    const schema = z.strictObject({ required1: z.string(), required2: z.number() });

    const result = schema.safeParse({ [STRICTNESS_PROBE_KEY]: 'x' });

    expect(result.success).toBe(false);
    const codes = result.error?.issues.map((issue) => issue.code) ?? [];
    expect(codes).toContain('unrecognized_keys');
    // ...and the missing-field errors are present too — i.e. zod did NOT stop at the first problem.
    expect(codes.filter((code) => code === 'invalid_type')).toHaveLength(2);
  });

  test('the unrecognized_keys issue carries the probe key in `keys`, not in `path`', () => {
    // The probe matches on `keys`. Zod puts offending key names there and leaves `path` at the
    // object root; a probe that looked in `path` would never match and would report every strict
    // schema as loose. Pinned so a zod upgrade that moved it fails HERE, by name.
    const schema = z.strictObject({ a: z.string() });

    const result = schema.safeParse({ [STRICTNESS_PROBE_KEY]: 1 });

    const issue = result.error?.issues.find((i) => i.code === 'unrecognized_keys');
    expect(issue).toBeDefined();
    expect((issue as { keys?: string[] }).keys).toEqual([STRICTNESS_PROBE_KEY]);
    expect(issue?.path).toEqual([]);
  });

  test('a schema that DECLARES the probe key reads as non-strict — fail closed, not open', () => {
    // The documented residual: an (absurd) schema declaring the probe key would have the key
    // recognized, so no unrecognized-keys issue is raised and the probe says "not strict". That is
    // a false REJECTION — loud and safe — never a false acceptance. Pinned so the direction of the
    // failure stays a decision rather than an accident.
    const schema = z.strictObject({ [STRICTNESS_PROBE_KEY]: z.string() });

    expect(isStrictSchema(schema)).toBe(false);
  });

  test('a throwing schema reads as non-strict rather than escaping', () => {
    // `isStrictSchema` runs inside `defineModule`, at import time. A schema whose parse throws
    // something exotic must not take the process down with an unrelated stack trace; it must land
    // as the typed "not strict" startup failure naming the op type.
    const schema = {
      parse(): never {
        throw new Error('schema exploded');
      },
    };

    expect(isStrictSchema(schema)).toBe(false);
  });
});
