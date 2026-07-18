# TASK 104 — the same exact-match-vs-subpath class survives in the platform-free prong: `ws/<subpath>` escapes `PLATFORM_FORBIDDEN`

**Status:** todo
**Priority:** **LOW** — the identical latent inconsistency task 95 closed for DB drivers, one prong over, but low materiality: `ws` is not a DB driver and platform-free code (`core`/`schemas`/`i18n`/`modules`) has no reason to import a `ws` subpath. No live escape. Filed so the class is closed everywhere, not left as a surprise for the next reader (the project's "close the class, not the instance" discipline — T-12).
**Depends on:** 95
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (task 95, out of scope by constraint)

`tooling/eslint/src/plugin/rules/boundaries.js`'s **platform-free prong** checks `PLATFORM_FORBIDDEN` with `/^ws$/`, which matches only the bare specifier `ws`. So a `ws/<subpath>` import from a platform-free package would ESCAPE the prong. `react-native`, `expo`, `hono`, and `@op-engineering/` already match subpaths in that list; `ws` and (formerly) `pg` are the exact-match holdouts — and `pg`'s subpath hole is now incidentally closed by the DB-driver lock (task 95, which fires first). So `ws` is the last one.

Task 95 fixed the DB-driver prong (`DB_DRIVER_OWNERS.get(packageRoot(source))`) but was scoped to that prong; `PLATFORM_FORBIDDEN` is a different list with the same class.

## Acceptance

- Normalize the `PLATFORM_FORBIDDEN` match to the package root (reuse the SAME `packageRoot()` helper task 95 used — §2.8, one mechanism), OR make the `ws` entry match subpaths the way `@op-engineering/` does. Confirm it does not over-match (a package NAMED `ws-something` must not be caught — `packageRoot('ws-something/x')` is `ws-something`, not `ws`, so it's safe, but verify).
- **Falsify (§2.11):** add a RuleTester fixture — `import x from 'ws/lib/websocket.js'` from a platform-free package (e.g. `packages/core/src`) → RED (platform-forbidden); revert the fix → it goes green (the escape); restore → RED again. And a valid control: `ws/*` from a platform-BOUND package (apps/server) stays clean (server may use ws).
- `pnpm lint`/`pnpm typecheck`/`pnpm test` for `eslint-config` green — read the output (§2.1).

## Note
Filed from task 95's sweep. Same shape, same fix, different list. Whoever takes it can likely reuse `packageRoot` and close the last exact-match holdout in one edit.
