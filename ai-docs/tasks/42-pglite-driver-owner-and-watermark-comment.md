# TASK 42 — `@electric-sql/pglite` escapes the DB-driver lock; the watermark `Number()` comment overstates its evidence
**Status:** in-progress
**Priority:** LOW (both latent; both are "a guard/comment doesn't cover what it claims"). From task 11 review (review-03).
**Depends on:** 11

Two small, related findings — each is a claim that is broader than what holds.

## F1 — pglite is not in `DB_DRIVER_OWNERS`, so the `testOnly` lock doesn't catch it

The DB-driver boundary lock enforces that test-only engines never reach shipping source (08 §2.5). It covers `op-sqlite`, `pg`, `better-sqlite3` — **not `@electric-sql/pglite`**. review-03 proved the gap with a positive control:

```
better-sqlite3 imported into shipping core src  => BLOCKED: "'better-sqlite3' is test-only (08 §2.5)…"   [control: the lock works]
@electric-sql/pglite imported into the SAME file => CLEAN                                                 [the gap]
```

So the discipline that catches better-sqlite3 does not catch pglite. **Latent, not live** — no shipping src imports pglite today (`packages/harness` carries it as a *legitimate* shipping dep: it is test tooling, so it must stay allowed there). **Pre-existing** — db-server and apps/server already carried pglite as devDeps; task 11 widened the set to core, which is what surfaced it.

**Fix:** add one `DB_DRIVER_OWNERS` entry for `@electric-sql/pglite` with `testOnly: true` scoped to core / db-server / apps-server, and NOT `packages/harness` (where it ships legitimately). Then **falsify** (§2.11): import pglite into shipping core src, watch the lint go RED with the same message shape better-sqlite3 gets, restore. And confirm `packages/harness`'s legitimate pglite import still passes — a positive control on the exemption, so the fix isn't a blanket ban (the boundary-rule bug this repo already shipped once).

## F2 — the `watermarks.ts` `Number()` comment claims a string return this suite's engine doesn't produce

Task 11's dialect fix normalizes `bigint`→`Number` in `createSqlWatermarkStore`, with a comment stating Postgres returns int8 "**as a string**". That is true of the **real `pg` driver** (task 07's `allocateServerSeq` needs exactly this cast). It is **not** true through **PGlite**, which this suite's only Postgres is — PGlite returns a number, so the cast is a no-op here and the suite cannot demonstrate the claim the comment makes.

The cast is correct and load-bearing (against real `pg`); only the comment overstates its evidence. **Fix:** reword to *"the real `pg` driver returns int8 as a string; PGlite returns a number — normalize for both."* No code change. Same species as the false claims this session keeps surfacing (task 10's brand comment, task 11's own "dialect-neutral" docblock, task 41's lock comment): a comment asserting something the running test can't back.

## Docs to read

- `tooling/eslint` — the `DB_DRIVER_OWNERS` map + the `testOnly` boundary rule (08 §2.5). Read how better-sqlite3 is entered; mirror it.
- `packages/core/src/projection/watermarks.ts` — the `Number()` cast + its comment.
- `08-stack-and-repo.md` §2.5 (test-only engines), §2.2/§2.4 (which packages legitimately ship pglite).
- `CLAUDE.md` §2.11; `testing-guide.md` T-11, T-13.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `tooling/eslint/**` (the driver-owner map — **contended**, serialize).
- `packages/core/src/projection/watermarks.ts` (comment only — **`@bolusi/core` contended**, serialize).

## Acceptance

- **F1 falsified**: pglite into shipping core src → lint RED (message names it test-only); `packages/harness`'s pglite import stays CLEAN (positive control); restore. Assert the driver-owner denominator (T-14): the map's covered-driver count went up by one and no existing entry regressed.
- **F2**: comment reworded to match what the suite can actually show; no behaviour change; `allocateServerSeq`'s real-`pg` path still relies on the cast (don't remove it).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green. **Read the output, not the exit code** (§2.1).

## Note

Both found by review-03 while driving task 11, and both correctly sized LOW rather than inflated. F1 is the more interesting: the lock looked complete because it caught the driver everyone tests with (better-sqlite3), so nobody noticed the one it didn't name. A guard that covers the cases you think of is the recurring shape here — the driver lock is T-12 in the boundary plane.
