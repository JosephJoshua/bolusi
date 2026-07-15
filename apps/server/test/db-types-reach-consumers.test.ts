// The generated `DB` type must actually REACH this package (10-db-schema §1, §11.4; task 39).
//
// The defect this guards against: `packages/db-server/src/generated/db.ts` used to be an input
// `.d.ts`. `tsc` does not copy an input `.d.ts` into `outDir`, so `dist/generated/` was never
// emitted — while `dist/index.d.ts` still said `export type { DB } from './generated/db.js'`.
// That re-export dangled, TypeScript resolved the missing module to `any`, and every consumer of
// @bolusi/db-server silently typechecked against an untyped `DB`. All of apps/server — every
// selectFrom, every column reference in tasks 12/13/16/19 — compiled against `any` for weeks with
// a green `tsc`. Nothing failed, because there was nothing to check.
//
// WHY THIS GUARD LIVES HERE AND NOT IN db-server: the bug is invisible from inside the package.
// The source types are correct; only the *built artifact* is missing. `packages/db-server`'s own
// typecheck reads `src/`, so it passes either way. Only a consumer resolving through the package's
// `exports` map (→ `dist/index.d.ts`) can see it. Move this file into db-server and it stops
// testing anything — which is exactly how the original defect survived.
//
// Both halves below fail RED when the emit regresses:
//   - the type-level block breaks `pnpm typecheck`
//   - the runtime test breaks `pnpm test`
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import type { DB } from '@bolusi/db-server';
import { expect, test } from 'vitest';

// --- Type-level guard (fails `tsc`, not vitest) -------------------------------------------------

// (1) THE LOAD-BEARING CHECK. A table key that does not exist MUST be rejected.
//
// WHICH DIRECTION IT FAILS, and why that is the whole point:
//   - `DB` real  → `DB['this_table_...']` errors (TS2339); the directive consumes it → GREEN.
//   - `DB` any   → `any['this_table_...']` raises NO error, so the directive has nothing to
//                  suppress → TS2578 "Unused '@ts-expect-error' directive" → RED.
// So the directive is *inverted* relative to intuition: it goes red precisely when the type
// system stops working. Verified by falsification (task 39): restoring the input-`.d.ts` emit
// produced exactly `TS2578` on the line below, with `tsc -b` still green.
// @ts-expect-error - DB must not accept a table that does not exist
export type _BogusTableIsRejected = DB['this_table_does_not_exist_anywhere'];

// (2) DENOMINATOR (T-14: a guard must assert its own coverage). Check (1) alone is also satisfied
// by a non-`any` but useless `DB` — an empty stub rejects a bogus key just as well as the real
// schema does. These two lines fail unless `DB` is the REAL generated schema: a known table, and a
// known column on it. They are what stops (1) from passing while describing no database at all.
export type _KnownTable = DB['operations'];
export type _KnownColumn = DB['operations']['serverSeq'];

// (3) DO NOT "STRENGTHEN" THIS WITH `IsAny<T> = 0 extends 1 & T ? true : false`.
// It looks like the obvious primary assertion and it is DEAD for this defect. When `DB` comes from
// an unresolved re-export it is not a normal `any`, it is TypeScript's internal *errorType*, which
// propagates through a conditional type instead of resolving to `true` — so `const _: IsAny<DB> =
// false` compiles clean in exactly the broken state it claims to detect. Measured, with a control,
// during task 39's falsification: `IsAny<RealAny>` errored TS2322 on the same run where `IsAny<DB>`
// stayed silent. The `@ts-expect-error` in (1) is the only type-level mechanism that catches it.

// --- Runtime guard (fails `pnpm test`) ----------------------------------------------------------

// Asserts the emitted artifact directly, by following the SAME re-export TypeScript follows.
// A type-level check alone would go quiet if this file ever stopped importing `DB`; this half
// fails with a message that names the actual cause.
test('the DB type re-exported by @bolusi/db-server resolves to an emitted declaration', () => {
  const requireFrom = createRequire(import.meta.url);
  const distDir = dirname(requireFrom.resolve('@bolusi/db-server'));
  const indexDts = join(distDir, 'index.d.ts');

  expect(existsSync(indexDts), `${indexDts} does not exist — the package was not built`).toBe(true);

  // Find the `export type { DB } from '<specifier>'` line and capture where it points.
  const source = readFileSync(indexDts, 'utf8');
  const reExport = /export\s+type\s*\{[^}]*\bDB\b[^}]*\}\s*from\s*'([^']+)'/.exec(source);

  // DENOMINATOR: if the re-export is not found, this guard is checking NOTHING. Fail loudly rather
  // than pass vacuously — the failure mode CLAUDE.md §2.11 keeps warning about.
  expect(
    reExport,
    `no \`export type { DB } from '...'\` found in ${indexDts}; this guard would silently check nothing`,
  ).not.toBeNull();

  const specifier = reExport?.[1] as string;
  // TS declaration re-exports use the .js specifier; the declaration beside it is .d.ts.
  const target = resolve(distDir, specifier.replace(/\.js$/, '.d.ts'));

  expect(
    existsSync(target),
    `${indexDts} re-exports DB from '${specifier}', but ${target} was not emitted. ` +
      `TypeScript resolves this dangling re-export to \`any\`, so every consumer of ` +
      `@bolusi/db-server would silently lose all schema typing (10-db-schema §11.4).`,
  ).toBe(true);
});
