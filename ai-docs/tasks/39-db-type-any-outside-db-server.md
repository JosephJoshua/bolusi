# TASK 39 — `DB` is `any` for every consumer of `@bolusi/db-server`; all of `apps/server` is untyped against the schema
**Status:** in-review
**Depends on:** 05

## Goal

Make `@bolusi/db-server`'s generated `DB` type actually reach its consumers, so a typo'd table or column in `apps/server` fails `tsc` instead of compiling clean.

**The defect.** `packages/db-server/src/generated/db.d.ts` is an **input** `.d.ts`. `tsc` does not copy input declaration files to `outDir`, so `packages/db-server/dist/generated/` **does not exist** — while `dist/index.d.ts` line 2 still says:

```ts
export type { DB } from './generated/db.js';
```

That re-export dangles. TypeScript resolves the missing module to `any`, and every consumer of `@bolusi/db-server` silently gets an untyped `DB`.

**Reproduced by the orchestrator, both directions** (task 07 found it; this is the independent confirmation):

| probe | result |
| ----- | ------ |
| `type Probe = DB['this_table_does_not_exist_anywhere']` **from `apps/server`** | **EXIT=0 — no error**. `DB` is `any`. |
| the same probe **inside `packages/db-server`** | **EXIT=2, TS2339** — correctly typed |

The types exist and are correct. They just never leave the package.

**Blast radius: all server code merged to date.** Tasks 12 (server-app), 13 (auth-server), 16 (sync-server, not yet built), 19 (media-server) all write Kysely queries from `apps/server`. Every one of them has been compiling against `any`. `forTenant`, every `selectFrom`/`insertInto`, every column reference — none of it has been checked. `pnpm typecheck` has passed for weeks because **there was nothing to check**.

**Why this is the worst instance of the pattern so far.** The seven prior cases (CLAUDE.md §2.11) were *test guards* that passed without testing. This is **the type system itself** silently checking nothing across an entire application — the tool everyone trusts most, failing in the one way nobody inspects. A green `tsc` is the least-questioned signal in the repo. And it is precisely the hazard `10-db-schema.md` **§11.4 already documents for the client**, where it is fixed by emitting `.ts` — db-server has the identical hazard, unfixed, and nobody connected the two.

## Docs to read

- `10-db-schema.md` **§11.4** — the same hazard documented for the client, and the `.ts`-emit fix. This is the precedent; read it before choosing a shape.
- `08-stack-and-repo.md` §5 (build/toolchain, `tsc -b` conventions), §3.2 (the db-server boundary rule — `pg` is boundary-locked).
- `packages/db-server/tsconfig.build.json`, `src/index.ts`, `dist/index.d.ts`, the kysely-codegen invocation (`db:codegen`).
- `testing-guide.md` T-14 (a check must assert its own denominator), T-14c (a stale build is a fake green — same family: the artifact you think you're checking isn't the one you are).
- `CLAUDE.md` §2.11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/db-server/**` — codegen output shape, `tsconfig.build.json`, `src/index.ts`.
- Possibly `10-db-schema.md` §11.4 (doc-first if the emit shape changes) and `package.json` `db:codegen`.
- **Coordinate:** `packages/db-server` is touched by task 34 (dev-Postgres isolation, in review) — serialize behind it. Do NOT run beside another db-server agent.
- **Expect fallout in `apps/server`.** Once `DB` is real, previously-`any` queries will typecheck for the first time. That is the point.

## Acceptance

**Observable done-condition:** `type Probe = DB['this_table_does_not_exist_anywhere']` **fails `tsc` from `apps/server`**, and the whole repo still typechecks — or the failures it surfaces are real bugs, fixed or reported.

- **Reproduce first** (T-11): run the probe from `apps/server`, watch it pass (EXIT=0); run it inside `db-server`, watch it fail (TS2339). That asymmetry is the bug. If it doesn't reproduce, stop and report.
- **Fix the emit, following the client's precedent** (§11.4): make the generated types a real emitted artifact rather than an input `.d.ts` that vanishes at build. Doc-first if the shape changes.
- **THE GUARD IS THE DELIVERABLE, not the fix** (§2.11/T-14). A one-line config change that works today and silently regresses at the next codegen tweak is this bug again on a delay. Ship a check that **fails** when `DB` degrades to `any` from outside the package — e.g. a type-level assertion in a consumer package (`@ts-expect-error` on a bogus table key, which errors if the key is *accepted*), wired into `typecheck` or the test suite. **Falsify it**: break the emit, watch the guard go red, restore, watch it pass. Note the trap in the obvious approach — a plain `@ts-expect-error` on a nonexistent table is only meaningful if `DB` is real; if `DB` is `any` the expected error never occurs and `@ts-expect-error` *itself* errors. Confirm you know which direction your guard fails in, and prove it.
- **Then find out what it was hiding — this is where the value is.** With `DB` real, run `pnpm typecheck` and report **every** error it surfaces across `apps/server`. Each is a query that has never been checked. **Do not paper over them**: a wrong column name is a real bug (it would fail at runtime only if a test happened to exercise that path). Fix the mechanical ones; if any error reveals a genuine schema/logic mismatch in merged code (tasks 12/13/19), **report it separately and loudly** — that is a defect that shipped, not a chore.
- **Check the sibling packages** (T-12 — the class, not the instance): does `@bolusi/db-client` actually apply its §11.4 fix, or is it documented-but-not-done? Does any other package re-export a type from an input `.d.ts`? The bug is not "this file"; it is "we export types we don't emit."
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green. **Read the output, not the exit code** (§2.1).

## Note

Found by task 07 — not by looking for it, but because *an expression typechecked in `apps/server` and failed in `db-server`*, and it asked why instead of moving on. It stopped and reported rather than fixing it inside an oplog task (§2.3), which is exactly right: the fix is cross-cutting and touches four other tasks' code.

The uncomfortable part worth stating: **review-02 reviewed and approved task 13 (auth-server) against this.** Its verdict stands — it verified D14's behaviour against a real PostgreSQL 16 catalog at runtime, which is stronger evidence than any type. But the *unexercised* query paths in tasks 12/13/19 have had no compile-time check at all, and nobody knew, because a green `tsc` is the one signal nobody re-examines. That is the whole thesis of §2.11, arriving at the tool we trust most.
