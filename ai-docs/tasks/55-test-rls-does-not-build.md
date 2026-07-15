# TASK 55 — `test:rls` doesn't build: the project's ONLY real-Postgres lane cannot resolve `@bolusi/core` in CI
**Status:** todo
**Priority:** **HIGH** — this lane carries every real-driver claim in the project, including task 46's guard for a class that had a *live production bug*. Third violation of the same normative rule.
**Depends on:** 46

## The finding (task 48, confirmed by the orchestrator)

**Evidence, each verified:**
- `"test:rls": "BOLUSI_DB_ENGINE=postgres node scripts/db-lane.mjs --db=bolusi_rls_test -- vitest run --project db-server"` — **no `tsc -b`**.
- `scripts/db-lane.mjs` — **does not build**.
- Root `package.json`'s only `prepare` is `git config core.hooksPath .githooks` — **no build on install**.
- `@bolusi/core`'s `exports` are **dist-only**: `"." → { types: "./dist/index.d.ts", default: "./dist/index.js" }`. Neither vitest config aliases it to `src`.
- **Two** db-server tests import `@bolusi/core`: `sync-batch-atomicity.test.ts` (task 16) and `projection-int8-marshalling.test.ts` (task 46).
- CI's `rls-witness` job runs: checkout → `corepack enable` → setup-node → `pnpm install --frozen-lockfile` → `check-tenant-context.mjs` → `db:stamp` → **`pnpm test:rls`**. **No build step anywhere.**

**So after a fresh checkout there is no `dist`, and those two tests cannot load** — the exact `Failed to resolve entry for package "@bolusi/core"` failure seen repeatedly in fresh worktrees today.

**08 §5.6 is normative:** *"any test script that imports a built cross-package entry MUST prefix `tsc -b &&`."* This is its **third** violation, each found separately after shipping: task 32 repaired `test:server`, task 24 repaired the mobile lane (and found the naive fix insufficient — see below), and now the rls lane. **A rule violated three times isn't enforced; it's remembered, badly.**

## Why this is HIGH and not a chore

`test:rls` is the **only lane that runs the production `pg` driver**. Everything else runs better-sqlite3 or PGlite, which return `int8` as a **number** where `pg` returns a **string** (T-14f). That difference produced a live production bug: `highestContiguousServerSeq` never advanced (task 46).

**Task 46 built `projection-int8-marshalling.test.ts` specifically to catch that class — and it is one of the two tests that cannot load in CI.** The guard for the bug every other lane was blind to sits in the lane that doesn't run.

**And locally it's worse than absent — it's a liar.** Task 48 hit this and nearly published it:
> *"My first staged reproduction tested **stale pristine dist** while source maps pointed the trace at `src` — **it looked live**. Discarded and re-run. Any rls-lane falsification without `tsc -b` reads the same unchanged bundle twice."*

Locally `dist` usually exists (left by a prior `pnpm test`), so the lane runs — **against whatever was built last**. Edit `core/src`, run `test:rls`, and you are testing the old bundle. **Every falsification anyone has done through this lane is only valid if they rebuilt.** Tasks 46 and 48 both did (and said so). Nobody was forced to.

## Docs to read

- `08-stack-and-repo.md` **§5.6** — the normative rule and its two recorded repairs. Read task 32's and task 24's entries; you are the third.
- `package.json` (`test:rls`, and the root `test`/`test:server`/`test:appliers` which **do** comply), `scripts/db-lane.mjs`.
- `.github/workflows/ci.yml` — the `rls-witness` job.
- `ai-docs/tasks/24-app-shell.md` — **read its FIX 1 before writing yours.** The naive `tsc -b &&` was **still a fake green** there: `tsc -b` resolves the *nearest* tsconfig, and if that project has no `references` it builds nothing. Only `tsc -b ../..` (the root solution file, which holds every reference) worked. **Check which tsconfig your prefix resolves and prove it rebuilds.**
- `testing-guide.md` T-14c (stale build = fake green), T-14f (both engines ≠ both drivers), T-11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- Real Postgres via the task-34 lane: `pnpm db:up` (read output), confirm `attribution OK … owned by '<your project>'` (T-14d), `pnpm db:down` after.

## Acceptance

**Observable done-condition:** from a tree with **no `dist`**, `pnpm test:rls` builds and runs — and editing `packages/core/src` changes what the lane observes.

- **Reproduce both failures first** (T-11): (a) wipe every `dist`, run `pnpm test:rls`, watch it fail to resolve `@bolusi/core` — that's CI; (b) with `dist` present, edit a `core/src` file the rls tests exercise, run `pnpm test:rls` **without** rebuilding, and watch it report the **old** behaviour — that's the local liar. If either doesn't reproduce, the premise changed: **stop and report**.
- **Fix the script**, and **prove the prefix actually rebuilds** — do not assume `tsc -b` resolves the solution file (task 24's trap). Show the build output changing `dist` before vitest runs.
- **Fix CI**, or state why the script fix suffices. The `rls-witness` job must build before `test:rls`, or the script must do it.
- **Falsify** (§2.11): with the fix, an edit to `core/src` **changes the lane's result** without a manual rebuild; revert the fix → the lane goes back to reporting stale. That is the whole property.
- **Sweep the class** (T-12) — this is the third instance, so **enumerate every script that runs tests**, and for each: does it import a built cross-package entry, and does it build? Name the total and the verdict per script. §5.6 has now been violated three times by three different agents; **the deliverable is a check that makes a fourth impossible**, not a fourth repair. Consider a gate that fails when a test script imports a `dist`-resolved workspace package without a build prefix.
- `pnpm test`, `pnpm test:rls`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by task 48 while falsifying its own fix — it noticed its first reproduction *looked* live because source maps pointed at `src` while the runtime read a stale bundle. It discarded the result rather than publish it. That instinct is the only thing that caught this: **the lane fails silently in the direction of agreement.**

The irony is worth recording. Task 46 exists because every test lane used a non-production driver. It built the one lane that uses the real driver — and that lane doesn't run in CI and doesn't rebuild locally. **The guard against "green for the wrong reason" was itself installed somewhere that can only be green for the wrong reason.**
