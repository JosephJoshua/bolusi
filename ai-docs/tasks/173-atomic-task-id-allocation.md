# TASK 173 — task ids are allocated by hand-reading `_index.md`, so concurrent branches collide; add `pnpm task:new`

**Status:** todo
**Priority:** MEDIUM — not a product defect, but a recurring tax on the parallel-agent workflow that CLAUDE.md §4 is built around. It has already cost real time.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** orchestrator, 2026-07-23, after the **third** id collision in one session.

## The finding
There is a `pnpm task:status` (writes both §2.6 locations atomically) but **no `pnpm task:new`**. To
create a task, an agent reads the highest id in `ai-docs/tasks/_index.md` and picks the next one. That
read is against a **per-worktree** `_index.md`, which is stale the moment two agents file concurrently
— which is the normal case in a fan-out phase, not the exception.

**Demonstrated three times in one session (2026-07-23):**
1. `162` was chosen by the orchestrator (emulator gates) AND by impl-150 (blank seed values), from
   branches cut minutes apart. impl-150 renumbered to 165.
2. `163` was chosen by impl-162 (dispatch-only lanes) AND by impl-154 (OWED failure-mode). impl-154
   renumbered to 166.
3. The orchestrator's own `>>`-append to a mistyped `129-*.md` filename silently created a SECOND
   file sharing id 129 — caught only by the ledger gate's `duplicateFiles` check going red. (Different
   mechanism — a shell footgun, not concurrency — but the same failure: two artifacts, one id.)

Each cost a renumber-and-re-merge cycle: `git mv`, heading edits, self-reference greps, an `_index.md`
conflict resolution, and a re-run of the ledger. Multiply by the fan-out width.

## Deliverable
`scripts/task-new.mjs` + `pnpm task:new "<title>" [--deps a,b] [--status todo]` that:

1. **Allocates the id against `origin/main`, not the local tree.** Fetch (or require a fresh fetch),
   read the highest id on `origin/main`'s `_index.md`, and take the next. This does NOT fully prevent
   two *simultaneous* callers picking the same next id — see below — but it removes the dominant cause,
   which is a stale local base, not true simultaneity.
2. **Writes the file and the `_index.md` row in one action**, the same both-locations-or-neither
   discipline `task:status` already has, so a created task can never have a row without a file or a
   file without a row (the two states the ledger gate exists to catch).
3. **Refuses to reuse an id that exists on `origin/main` OR in the local tree**, and refuses a
   filename whose slug collides.
4. Optionally: reserve the id with an empty committed stub on a throwaway ref, or print a `git`
   one-liner the caller runs immediately — so the window between "picked id" and "pushed row" is
   closed by a push, not by hope. Keep this simple; a full lock server is out of scope.

## The honest limit — state it in the tool's own output
Allocating against `origin/main` shrinks the race to the interval between two callers who both fetch,
both see id N as highest, and both pick N+1 before either pushes. That window is small but nonzero.
**The tool must not claim to make collisions impossible.** The real backstop stays the ledger gate's
`duplicateRows` / `duplicateFiles` checks (task 66) — which is what caught collision 3 above and must
keep running. `task:new` reduces the collision *rate*; the ledger gate remains the thing that makes a
collision *loud*. Do not let adding the tool tempt anyone to weaken the gate.

## FALSIFY (§2.11)
- Create a task with `task:new` and confirm BOTH the file and the row appear, and the ledger gate is
  green immediately after (no manual `git add` dance needed — or if one is, the tool prints it).
- Point the tool at a tree where `origin/main` already has the id it would pick, and confirm it
  refuses rather than overwrites.
- Break the both-locations-atomicity (write the file but not the row) in a test and confirm the ledger
  gate reds — i.e. that the backstop still backstops the new tool.
- **Positive control:** a legitimately-next id is accepted and lands green.

## Note
This is a `scripts/`-only change and touches no product code. It is contended only with other edits to
the task tooling — coordinate with whoever holds `task-status.mjs` if that is being changed in parallel.
