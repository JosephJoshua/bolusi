# TASK 34 — the dev Postgres is a shared singleton; parallel worktrees silently share (and corrupt) one database
**Status:** done
**Depends on:** 05

## Goal

Make a DB test's database **attributable and isolated**, so a worktree either gets its own Postgres or fails loudly — never silently borrows a peer's.

**The defect.** `docker-compose.yml` publishes a **fixed** host port `127.0.0.1:5432:5432`, and `package.json`'s `test:rls` targets a **hardcoded** `localhost:5432`:

```
"test:rls": "BOLUSI_DB_ENGINE=postgres DATABASE_URL=${DATABASE_URL:-postgres://bolusi:bolusi@localhost:5432/bolusi_rls_test} vitest run --project db-server"
```

On this shared docker daemon, only the **first** worktree to `db:up` binds 5432. Every later worktree:

1. `db:up` **fails** — `Bind for 127.0.0.1:5432 failed: port is already allocated`, EXIT=1;
2. its DB tests **still pass** — silently connecting to whichever worktree owns the port, applying their migrations into that peer's database.

**Two distinct harms:**
- **Unattributable greens.** Real incident (task 13): the orchestrator's own gate verification reported "82/11 on real PG16" — produced by **task 05's leaked container**, because `db:up` ran as `>/dev/null 2>&1` and its EXIT=1 was never read. The result was real; the reasoning was fiction. Caught only because review-02 noticed the D14 objects were absent from the container it was inspecting *while the tests were green*.
- **Mutual corruption.** Two worktrees running DB tests concurrently share one database and clobber each other's fixtures. This has already happened once in a different shape (T-14b: a parallel process reset the schema mid-probe, and the RLS probes returned `0 rows` — reading as flawless tenant isolation while being completely vacuous).

This is the second incident from the shared daemon and the reason T-14b/T-14d exist. It is a **parallel-agent-workflow defect**, not a product bug — which is exactly why nobody owns it and it keeps biting.

**Note the asymmetry:** CI is unaffected (isolated service containers per job). So **local and CI disagree about whether isolation exists, and only local lies.** A fix must not "work" by making CI's already-correct setup more complicated.

## Docs to read

- `08-stack-and-repo.md` §6.1 (dev services; compose is dev-only — real environments never use compose).
- `testing-guide.md` **T-14b** (the first shared-daemon incident), **T-14d** (this one), T-10 (flaky = P1), T-14 (a guard asserts its own denominator).
- `10-db-schema.md` §6 (RLS/roles — the `test:rls` lane's actual subject).
- `CLAUDE.md` §2.1 (never trust an exit code), §4 (parallel-agent safety — the workflow this defect breaks).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `docker-compose.yml` (the fixed port binding).
- `package.json` — `db:up`, `db:down`, `test:rls`, `test:server` scripts.
- `packages/db-server/test/**` setup — the attribution assertion.
- Possibly `.github/workflows/**` — **coordinate with task 32**, which owns the CI `server-integration` job. Do not both edit that workflow.

## Acceptance

**Observable done-condition:** two worktrees can run `pnpm test:rls` **simultaneously** without touching each other's data, and a worktree that cannot get its own database **fails loudly** instead of borrowing one.

- **Reproduce the bug first, as a test you watch go red.** With a peer container holding 5432, show that today's `test:rls` connects to the *foreign* container and reports green. That reproduction is the whole point of this task; if you cannot make it happen, do not "fix" anything — report that instead.
- **Isolate.** Give each worktree its own database. Suggested (choose and justify): drop the fixed host port and resolve the real one via `docker compose port postgres 5432` into `DATABASE_URL`; or derive a deterministic per-project port; or run Postgres on the compose network and exec tests against it. Constraint: it must keep working on a machine with **no** peer containers (the solo-developer case) and must not require an agent to know about other agents.
- **Attribution is asserted, not assumed** — this is the load-bearing part (T-14/T-14d). The DB test setup SHALL prove the database it reached is **its own** (e.g. stamp the compose project name into the container's DB at init and assert it matches `$COMPOSE_PROJECT_NAME` before any test runs), and **abort the suite** on mismatch. **Falsify it** (CLAUDE.md §2.11): point your worktree at a peer's database, watch the suite ABORT with a clear message, restore, watch it pass. An isolation fix that cannot detect its own violation is the same class of guard this repo has now shipped six times.
- **`db:up` fails loudly.** A failed `db:up` must not be survivable by a subsequent green DB test. Make the failure fatal to the lane (a `db:up` that exits non-zero blocks `test:rls`), so the "redirect to /dev/null and never know" path is closed by construction rather than by discipline.
- **Concurrency proof:** run `test:rls` in two worktrees at once, both green, neither's fixtures disturbed. Then deliberately have both write the same fixture id and show they do not collide.
- **Clean up leaked containers.** Provide a `db:down`-shaped path that removes a worktree's own container, and document that agents must never `docker compose down` a container that isn't theirs. (A leaked task-05 container squatted 5432 for 4+ hours and is what triggered this.)
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1) — and note that `cmd | head` returns *head's* status; that trap is live in this repo.

## Note

The fix is small; the reason it matters is not. Every parallel wave from here runs DB-touching tasks concurrently (07, 13, 16, 17, 19 all touch Postgres). Until this lands, **every local DB green in a multi-agent wave is unattributable**, and the merge gate rests on numbers whose source nobody checked. The orchestrator produced the first such number itself — the discipline in CLAUDE.md §2.1 was written *before* that happened and still did not prevent it, which is the argument for closing this by construction rather than by asking people to be careful.
