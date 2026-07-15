# TASK 29 — close the `z.float64()` bypass in `bolusi/no-float-money`
**Status:** in-review
**Depends on:** 02

## Goal

`bolusi/no-float-money` is the lint half of the money-integrity invariant (05-operation-log §3: money is always integer IDR; no floats in payloads). Task 02's review proved the rule has a hole: it pattern-matches only a `z.number` callee (`tooling/eslint/src/plugin/rules/no-float-money.js`, `callee.property.name === 'number'`), so **`z.float64()` — a real Zod 4 API — lints clean**. Verified via `eslint --stdin` under `packages/schemas/src/`: `export const zAmount = z.number()` errors; `export const zAmountIdr = z.float64()` does not. A future module author writing `amount: z.float64()` silently defeats the guard, and the failure surfaces as corrupted money data, not a lint error.

Close the gap: the rule must flag every Zod float constructor (`z.float64`, `z.float32`, and `z.number` without `.int()`), while keeping the **deliberate, legitimate** float64 use — `location.lat/lng/accuracyMeters` in `packages/schemas/src/envelope.ts` — passing. That exemption is real (location is envelope, not payload; 05 §3's integer rule does not reach it; `z.float64()` is in fact stricter than `z.number()` there because it rejects `NaN`/`Infinity`, keeping every admitted value JCS-serializable). Make the carve-out explicit and narrow rather than accidental.

Record the outcome in `08-stack-and-repo.md` §5.2, which currently documents no float64 carve-out at all — the rule simply never matched it. `envelope.ts`'s comment claiming the rule "deliberately does not target" float64 is presently false and must become true or go.

## Docs to read

- `08-stack-and-repo.md` — §5.2 (custom lint rules table: the rule's mandate and current documented scope).
- `05-operation-log.md` — §3 (canonical serialization: money-integer / no-floats-in-payloads rule this lint enforces; and why `location` sits outside it).

## Skills

- `superpowers:test-driven-development` — write the failing RuleTester case first (`z.float64()` in a schema file must error), then fix the rule.
- `superpowers:verification-before-completion` — evidence before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `tooling/eslint/src/plugin/rules/no-float-money.js` — the rule.
- `tooling/eslint/src/plugin/rules/no-float-money.test.js` — RuleTester cases.
- `packages/schemas/src/envelope.ts` — comment correction only (and an inline disable **with a linked reason** if the chosen carve-out mechanism needs one).
- `ai-docs/08-stack-and-repo.md` §5.2 — record the float-constructor scope + the location carve-out.
- **Contended:** `tooling/eslint` — serialize with any in-flight branch touching it (04/05/22 may add config blocks). Merge after them.

## Acceptance

**Observable done-condition:** `pnpm lint` is green across the repo, and a `z.float64()` money field in a schema file is an `error`.

Tests (RuleTester, in `no-float-money.test.js`):
- **invalid:** `z.float64()` and `z.float32()` in a schema-glob file ⇒ reported. Assert the message, not just the count.
- **invalid:** `z.number()` without `.int()` ⇒ still reported (no regression).
- **valid:** `z.number().int()` ⇒ clean (no regression).
- **valid:** the `location` shape (`lat`/`lng`/`accuracyMeters` as `z.float64()`) under whatever carve-out mechanism you choose — an allowlisted property-name set, a file+shape exemption, or an inline disable carrying a linked reason. Pick ONE, justify it in the rule header, and make the test pin it.
- **valid:** a non-schema file (e.g. a screens file) with `opacity: 0.5` ⇒ clean — task 01's F1 fix scoped the numeric-literal prong to schema globs; do not regress it.

Gates:
- `pnpm lint` and `pnpm test` green.
- `08-stack-and-repo.md` §5.2 states the rule's real scope (which constructors, which globs, which carve-out). The doc and the rule agree — that is the point of this task.
- `packages/schemas/src/envelope.ts`'s float64 comment is true after the change, or deleted.
