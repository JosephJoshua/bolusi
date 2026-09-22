# D26 — the D14 auth lookups are shared as query BUILDERS, not as handle-taking functions

**Date:** 2026-09-22 · **Status:** Accepted — task 204's own approach 1, taken as written.
**Amends:** nothing. D14 (`2026-07-15-auth-lookup-security-definer.md`) is untouched — the definer gating, the roles, and the fail-closed behaviour are exactly as they were.
**Closes:** task 204's requirement that a chosen approach touching the `@bolusi/db-server` export surface be recorded in a decision entry before it lands (§4 / §6).

## Why an entry exists at all

Task 204 says, unconditionally:

> "do not export `getDb` or thread an external Kysely into `auth-entry.ts`'s authz functions without a decision file — that would be a §6 security-control change"

and separately requires a note "if the chosen approach touches the db-server export surface."

**The first clause was violated once and reverted.** The initial implementation added
`findDeviceByTokenHashOn(db, …)` / `findControlSessionByTokenHashOn(db, …)` / `findLoginCredentialOn(db, …)`
to `auth-entry.ts` — precisely the handle-threading the task forbids — because the task file was never
read; only its one-line `_index.md` summary was. The PR-5 security review caught it. That shape is
gone; this entry records what replaced it.

## The decision

**Approach 1, verbatim from the task:** share the SQL, not the execution.

`packages/db-server/src/auth-lookup-queries.ts` exports three builders returning UNEXECUTED Kysely
`sql` fragments, plus `mapControlSessionRow` for the `int8` coercion that was also duplicated. Each
caller executes with the handle it already holds:

| Caller | Handle |
| ------ | ------ |
| `auth-entry.ts`'s three exported lookups | the package-private `getDb()` |
| `@bolusi/harness` `createPgliteAuthDirectory` | its own PGlite handle |

## Why this is not a §6 security-control change

- **No handle is exported, and none is accepted.** `getDb` stays unexported. No exported symbol takes
  a `Kysely`. A builder cannot execute anything by itself.
- **The boundary is unmoved.** The real control is the Postgres GRANT plus the SECURITY DEFINER
  function bodies (D14) — not which Kysely instance calls `.execute()`. Each builder still emits one
  fixed, keyed, definer-gated statement; no arbitrary cross-tenant query becomes expressible.
- **The export-surface assertions still bind**, verified by running the built module rather than by
  reading the code: `deviceByTokenHashQuery(...)` returns a `RawBuilderImpl` with **no `selectFrom`**,
  so `export-surface.test.ts`'s `queryish` check still covers it, and the "no raw db/pool/handle"
  assertion is unaffected.

## What it buys

The three SQL bodies were duplicated between `auth-entry.ts` and the harness's PGlite mirror, differing
only in the executor — an aware copy on a D14 cross-tenant path. The dangerous half was invisible to
the compiler: the **column aliases are string literals**, so renaming a definer column on one side left
the other silently selecting the old name with no build error, and the emulator lane would have kept
reporting a "production-auth" path that no longer mirrored production. The `Number()` int8 coercion had
the same exposure — drop it on one side and nothing reds until a token actually expires.

Falsified to task 204's own bar: `grep -rn 'auth_find_device_by_token_hash' packages --include=*.ts`
now shows the production literal **once** (the builder) plus two `.execute()` call sites. (The other
hits are the `CREATE FUNCTION` DDL, pre-existing raw-SQL negative-control tests, and
`security/tenant-probe.ts`, which deliberately reimplements its call as an independent SEC-TENANT-04
fixture and is untouched here.)

## Rejected alternatives

- **Handle-parameterised functions in `auth-entry.ts`** — what task 204 forbids, and what was briefly
  implemented. Rejected: it puts an external executor inside the package's authz path, which is a
  §6 change regardless of how narrow each individual function is.
- **Approach 2, keep two copies behind a byte-identity drift guard** — leaves two sources of truth and
  polices them, the shape task 188 rejected. Only warranted if approach 1 had breached the boundary.
  It did not.

## Residual risk

The builders are exported, so any future `@bolusi/db-server` consumer can run these three statements
against a handle it already owns. That is materially the same authority the three existing exported
lookups already grant — a fixed, keyed, definer-gated read whose result set is the function body's, and
nothing more. It does **not** extend to arbitrary cross-tenant SQL, which stays inexpressible through
this package.
