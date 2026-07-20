# TASK 36 — three CI jobs are labelled *merge gate* while passing trivially
**Status:** in-progress
**Depends on:** 11, 26

## Goal

`.github/workflows/ci.yml` has three echo-only placeholder jobs:

| job | placeholder because | real suite lands with |
| --- | ------------------- | --------------------- |
| ~~`dual-dialect-appliers`~~ | ~~`packages/modules` holds only a scaffold~~ | **CLOSED by task 11 (2026-07-15)** — stage 10 now runs `pnpm test:appliers` for real |
| `chaos-harness` | `packages/harness` likewise; `pnpm test:chaos` → `not-implemented.mjs` | task 26 |
| `device-lane` | EAS build + on-device smoke | task 27 |

**Update 2026-07-15 — stage 10 is closed, and it validated this task's whole premise on its first run.** Task 11 wired `dual-dialect-appliers` to the real `pnpm test:appliers` (better-sqlite3 behind the shim + PGlite, byte-equal oracle digests) and falsified it end-to-end — reintroducing a real `created_at integer` overflow turned the job red. It needs no `services:` block: PGlite is in-process, so it cannot collide with a peer worktree's database (T-14d).

**What the newly-real gate caught immediately — two live bugs in already-merged task 08 code:**
1. `createSqlWatermarkStore` was **documented "dialect-neutral raw SQL" and was SQLite-only.** 2-arg `MAX(a,b)` is a *scalar* in SQLite but an *aggregate* in Postgres, and the bare column is ambiguous there. Nothing noticed because it is only exercised against SQLite today — **tasks 07/16 (server-side projections) would have hit it.**
2. **ms-epoch (~1.7e12) overflows Postgres' 32-bit `integer`**; SQLite silently swallows it.

That is the argument for closing the remaining two, stated in evidence rather than principle: **the placeholder was not merely "not yet covering" — it was actively hiding two defects that had already shipped.** A green-for-nothing gate does not leave a gap where its coverage would be; it leaves a gap that *looks* covered, so nobody goes looking. Both bugs sat in merged code that every reviewer, including the orchestrator, had passed.

**These are honest placeholders today** — unlike task 32's `server-integration`, they shadow no existing suite, so nothing is silently uncovered. `not-implemented.mjs` exits 1 by design, which is the right shape.

**The defect is the label, and it is timed to fire later.** `08-stack-and-repo.md` §5.6 marks stages 10/11 as **merge gate**. If branch protection requires them, they are *required checks that pass unconditionally* — green-for-nothing. Today that is harmless because the suites they'd run don't exist. **The moment tasks 11 and 26 land, the identical bug becomes live**: a required gate reporting green while the real suite is either not wired to it or failing elsewhere. This is the sixth-and-seventh instance of the pattern CLAUDE.md §2.11 exists for, pre-scheduled.

Note the asymmetry that makes this worth its own task: a placeholder that exits **1** (like `not-implemented.mjs`) fails safe — nobody mistakes it for coverage. A placeholder that `echo`es and exits **0** fails *open*, and wears a "merge gate" label while doing so. The difference is one line, and it is the whole bug.

## Docs to read

- `08-stack-and-repo.md` §5.6 — the CI stage table; specifically which stages are labelled *merge gate* and what §7 record #9 now says (task 32 rewrote it).
- `testing-guide.md` T-11 (a guard is only load-bearing if someone has watched it go red), T-14 (a coverage check asserts its own denominator).
- `CLAUDE.md` §2.1 (never trust an exit code — a status describes the process it came from), §2.11.
- `ai-docs/tasks/32-*.md` — the sibling that already fixed one instance; read its §7 record so this task matches its shape.

## Skills

- `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `.github/workflows/ci.yml` — **coordinate with task 34**, which may also touch this workflow (dev-Postgres isolation). Do not both edit it concurrently.
- `08-stack-and-repo.md` §5.6 / §7 if a stage's label or status changes.

## Acceptance

**Observable done-condition:** no job labelled *merge gate* can report success without having run the thing it names — and if it cannot yet run it, the label says so.

- **Establish the actual risk before fixing it** — this determines whether the task is urgent or bookkeeping: check whether branch protection **currently requires** stages 10/11. If it does, they are live required-checks-that-prove-nothing and this is urgent. If it does not, this is a scheduled landmine and the fix is preventive. Report which, with evidence (`gh api` on branch protection, or state plainly that you could not read it and why).
- **Decide the honest shape** and justify it. Either: (a) the placeholder **fails** (route it to `not-implemented.mjs`, which already exits 1 by design — matching the sibling scripts' shape), so a required gate cannot be green until its suite exists; or (b) it stays green but the §5.6 label stops claiming *merge gate* until the suite lands. **(a) is preferred** — a red placeholder is honest about an unbuilt lane, while a green one launders absence into assurance. Choose (b) only if a permanently-red required check would block all merges, and say so.
- **The wiring must be verified, not asserted** (§2.11): whatever you choose, demonstrate it — show the job failing when it should fail. A fix to a fake-green that is itself unverified is the same bug in a new coat.
- **When tasks 11/26 land, the gate must catch a broken suite.** Add the check that makes that true rather than trusting the future implementer: the job runs the real command, has no `continue-on-error` (currently **zero** occurrences repo-wide — keep it that way), and asserts its own denominator (a non-zero test-file count; `passWithNoTests` stays unset so "matched zero files" cannot exit 0).
- **Sweep the whole workflow, not just these three.** Task 32 found `server-integration` promising more than it ran; this task found three more. Enumerate **every** job and state, per job, what command it runs and whether a real failure in its named subject would turn it red. That table is the deliverable — it is what makes this the *last* time we find one of these by accident.
- `pnpm lint` green; workflow YAML valid. **Read the output, not the exit code** (§2.1).

## Note

Filed from task 32's report. Its premise ("nothing runs the server suite in CI") turned out to be **wrong in an instructive way**: the `unit` job's unfiltered `vitest run` was already sweeping all 22 server files, so coverage was never lost — only the *named gate* was missing. That distinction is why nobody noticed for so long, and it is the reason this sweep must ask a precise question of each job: not "is this subject covered somewhere?" but **"would this specific job go red if its named subject broke?"** Those have different answers, and only the second one is what a merge gate promises.
