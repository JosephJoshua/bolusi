# TASK 95 — the DB-driver `testOnly` lock is bypassed by SUBPATH imports; `@electric-sql/pglite/worker` exports a real DB surface and escapes it from shipping src

**Status:** done
**Priority:** **MEDIUM** — a security-adjacent boundary bypass, not a live exploit. It is a **guard that silently checks nothing for a whole class of import** (CLAUDE.md §2.11): the `testOnly` DB-driver lock exists so a real SQL engine cannot be imported from shipping source, and a one-token change to the specifier walks straight through it. No shipping code imports a driver subpath **today** — this is closing the hole before it is used, exactly as §2.11 demands (falsify before you're bitten, not after).
**Depends on:** 42
**Blocks:** —
**SEC ids owned by THIS task:** none (hardens the boundary that backs the DB-driver isolation invariant; no new SEC id)

## The finding (task 42 review, rev-42 — independently falsified against the branch rule)

`tooling/eslint/src/plugin/rules/boundaries.js` resolves a driver by `DB_DRIVER_OWNERS.get(source)` on the **full import specifier**, so only the EXACT string matches. Subpaths escape. Proven by driving `rule.create().ImportDeclaration` on real specifiers from `packages/core/src/projection/engine.ts` (a shipping, non-owner path):

```
import { PGlite }       from '@electric-sql/pglite';          → dbDriverTestOnly   (CAUGHT)
import { PGliteWorker } from '@electric-sql/pglite/worker';   → []                 (NOT CAUGHT)
import x                from '@electric-sql/pglite/live';      → []                 (NOT CAUGHT)
```

Same escape from `apps/mobile/src`, `packages/schemas/src`, and every other locked workspace. **`@electric-sql/pglite/worker` exports `PGliteWorker` — a real, SQL-running DB surface** (pglite's package `exports`: `.`, `./template`, `./live`, `./worker`, `./nodefs`, `./opfs-ahp`, `./basefs`, `./contrib/*`). So the test-only engine reaches shipping source through an uncaught subpath. `better-sqlite3` and `pg` have the **identical** gap — task 42 faithfully mirrored `better-sqlite3`, subpath behaviour included — but they expose no DB-capable subpath, so pglite is what makes the gap materially reachable.

## The fix already exists one function away — do not invent a second mechanism (§2.8)

`check()` in the same file ALREADY normalizes op-sqlite subpaths:
```
source.startsWith('@op-engineering/') ? '@op-engineering/op-sqlite' : source
```
and rev-42's probe confirms `@op-engineering/op-sqlite/anything → dbDriver` (caught) while `pglite/sub` and `better-sqlite3/sub → []`. So op-sqlite is already immune and the other three are not — an inconsistency, not a new design problem.

## Acceptance

**Observable done-condition:** a subpath import of ANY locked driver from a non-owner/shipping path is caught exactly as the bare specifier is; legitimate test-only subpath usage (and the harness runtime exemption) still passes.

- **Generalize the existing normalization** to a `packageRoot(specifier)` that maps any driver subpath to its package root before the `DB_DRIVER_OWNERS` lookup — covering `@electric-sql/pglite/*`, `better-sqlite3/*`, `pg/*`, and keeping op-sqlite's `@op-engineering/*` behaviour. One mechanism for all four; delete the op-sqlite special-case if the general one subsumes it (verify it does).
- **Falsify per driver (§2.11):** add durable RuleTester fixtures — for EACH of the four drivers, an invalid case importing a real subpath from a shipping non-owner path must go RED with the same message the bare specifier produces; a valid case (test file / harness src) must stay green. Prove the fix by reverting it and watching **exactly** the new subpath fixtures fail (not the whole suite). State the denominator: 4 drivers × {bare, subpath} × {shipping, test} covered.
- **Pin the pglite reachability** as the load-bearing case: `@electric-sql/pglite/worker` from `packages/core/src` (or `apps/mobile/src`) → `dbDriverTestOnly`. That is the one that turns a latent inconsistency into a reachable bypass.
- **Comment accuracy (T-15):** task 42's `boundaries.js` header attributes harness's bundle hold-out to the "SHIPPING_WORKSPACES sweep"; rev-42 notes it is strictly the separate `@bolusi/harness`-never-a-runtime-dep test that does it. Correct the attribution while you are in the file (substantively harmless today, but the comment is the guard).
- `pnpm lint` (the rule runs over the whole repo — a real no-regression check on the two live pglite test-file imports), `pnpm typecheck`, `pnpm test` for `eslint-config` green. Read the output, not the exit code (§2.1).

## Note
Filed from task 42's review. Task 42 is correct and merged: its acceptance was "lock pglite like better-sqlite3, count 3→4, no regression" — all met, and mirroring better-sqlite3 faithfully **included** inheriting its subpath blind spot. This task closes that blind spot for the whole exact-match driver set at once, which is the right granularity — fixing it pglite-only would leave `pg`/`better-sqlite3` as the next agent's identical surprise.
