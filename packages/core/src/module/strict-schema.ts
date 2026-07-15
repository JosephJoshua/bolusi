// The `.strict()` check for payload schemas (04-module-contract §3: "payload schemas are
// `.strict()` — unknown keys rejected").
//
// ── WHY THIS PROBES BEHAVIOUR INSTEAD OF READING ZOD'S INTERNALS ───────────────────────────────
//
// @bolusi/core may not import zod (08 §3.3: core imports `schemas` + canonicalize + kysely types,
// nothing else) — modules own their schemas and hand them in, and `InputParser` is structural
// precisely so a real Zod schema drops in. So the obvious implementation — reach into
// `schema._zod.def.catchall` and check for a `never` — is unavailable, and would be a bad idea
// anyway: it pins core to one zod minor's private shape, and it would answer a question about a
// FIELD rather than about what the schema DOES. Zod 4.4's `.strict()` sets `catchall = z.never()`;
// zod 3's set `unknownKeys: 'strict'`. A check written against either is silently wrong on the
// other, and "silently checks nothing, reports green" is the failure mode CLAUDE.md §2.11 exists
// to prevent.
//
// So the check is a PROBE: hand the schema an object carrying one key it cannot know about, and
// look at what it says. That is the same property 04 §3 actually cares about ("unknown keys
// rejected"), which makes it robust across zod versions and across a hand-written `InputParser`.
//
// ── WHY THE PROBE IS A LONE UNKNOWN KEY AND NOT A VALID SAMPLE + AN EXTRA ──────────────────────
//
// The natural probe — "parse a valid payload plus one junk key" — needs a valid payload, and
// nothing here knows one (that is the module's business, and manufacturing one from a schema is
// the schema library's job). So the probe sends `{ [PROBE_KEY]: sentinel }` and NOTHING else. That
// object is invalid under essentially every real schema (required fields are missing), so all
// three object modes throw — and the verdict cannot come from success/failure. It comes from
// WHICH issues are reported:
//
//   z.strictObject({a,n}).parse({__probe__})  -> issues: invalid_type, invalid_type, UNRECOGNIZED_KEYS
//   z.object({a,n}).parse({__probe__})        -> issues: invalid_type, invalid_type
//   z.looseObject({a,n}).parse({__probe__})   -> issues: invalid_type, invalid_type
//
// The load-bearing fact is that zod does NOT short-circuit: it reports the unrecognized key
// alongside the missing-field errors. That is an assumption about someone else's library, so it is
// not assumed — `strict-schema.test.ts` drives real zod (a core devDependency, test-only, the same
// shape as better-sqlite3) through every case above, including the strict-with-no-required-fields
// and the wrapped (`.refine()`) forms. Interrogate the oracle (T-13): a probe verified only
// against a hand-rolled fake of zod would be a test of the fake.
//
// ── FAIL-CLOSED DIRECTION ─────────────────────────────────────────────────────────────────────
//
// Every ambiguous answer means NOT strict, i.e. a startup failure. A schema that declares
// PROBE_KEY as a real field would report "not strict" for a genuinely strict schema — a loud,
// wrong-in-the-safe-direction result, which is why the key is namespaced to be un-collidable
// rather than being a plausible field name.

import type { InputParser } from '../runtime/ctx.js';

/**
 * The key the probe sends. Namespaced so no real payload declares it: a schema that DID would be
 * reported as non-strict (a loud startup failure), which is the safe direction to be wrong in.
 */
export const STRICTNESS_PROBE_KEY = '__bolusi_strictness_probe__';

/** The probe's value. Arbitrary — only the KEY's fate is read. */
const PROBE_SENTINEL = '__bolusi_strictness_probe_value__';

/** One issue in Zod's shape. Structural: core cannot name `ZodError` (see the header). */
interface ParseIssueLike {
  readonly code?: unknown;
  readonly keys?: unknown;
}

/**
 * Does `error` report `PROBE_KEY` as an unrecognized key?
 *
 * Requires BOTH the `unrecognized_keys` code AND our key in `keys`. The `keys` check is what makes
 * this specific: an `unrecognized_keys` issue about some OTHER key would mean the schema rejected
 * something we did not send, which is not evidence about the probe.
 */
function reportsUnrecognizedProbeKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return false;

  return issues.some((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return false;
    const { code, keys } = issue as ParseIssueLike;
    if (code !== 'unrecognized_keys') return false;
    return Array.isArray(keys) && keys.includes(STRICTNESS_PROBE_KEY);
  });
}

/**
 * Is `schema` strict — does it REJECT unknown keys (04 §3)?
 *
 * `false` for a schema that strips unknown keys (zod's default) and for one that passes them
 * through (`z.looseObject`). Both are "not strict" for 04 §3's purpose: the doc's rule exists so a
 * payload's shape is exactly what the module declared, and a silently-stripped key is a fact the
 * client thought it recorded and the log does not contain.
 *
 * Never throws: any error from the schema is caught and read as evidence.
 */
export function isStrictSchema(schema: InputParser<unknown>): boolean {
  try {
    schema.parse({ [STRICTNESS_PROBE_KEY]: PROBE_SENTINEL });
    // Parsed an object consisting solely of an unknown key without complaint. Whatever this is, it
    // does not reject unknown keys.
    return false;
  } catch (error) {
    return reportsUnrecognizedProbeKey(error);
  }
}
