# TASK 57 — no gate stops a package re-exporting a type it doesn't emit
**Status:** todo
**Priority:** LOW (0 live instances — task 39 swept it clean) but the class shipped **the single worst instance this project has had**, and nothing prevents its return.
**Depends on:** 39

## Why this exists

Task 39 fixed `@bolusi/db-server` re-exporting `DB` from an input `.d.ts` that `tsc` never copied to `outDir`. The dangling re-export resolved to **`any`**, so **all of `apps/server` was untyped against the schema** and `pnpm typecheck` was green **because there was nothing to check** — the type system itself, silently checking nothing across an entire application, in the least-questioned signal in the repo.

Task 39 also **swept the class and found it otherwise clean** (denominators independently re-derived by review-06, whose own first count was wrong — 11 packages/29 targets because it missed `tooling/*`):

| check | result |
| ----- | ------ |
| input `.d.ts` under any `src/` | **0** |
| dangling relative re-exports | **0 of 335 specifiers across 207 emitted `.d.ts`** |
| package `exports`/`types` targets missing | **0 of 34 across 13 packages** |

The sweep was **falsified** — against a broken tree it reports 1 input `.d.ts` and names exactly the 3 dangling re-exports.

**Task 39 deliberately did not ship the sweep as a permanent gate**, because its natural home (`packages/test-support`) was contended (§4). That was the right call at the time. **The script is written and proven; it just has no home and no owner** — and per §2.7 a finding that lives only in an agent's report is a finding that dies there. review-06 flagged exactly this.

## Docs to read

- `ai-docs/tasks/39-db-type-any-outside-db-server.md` §Outcome — the sweep, its denominators, and its falsification. **The script exists; start there, don't rewrite it.**
- `10-db-schema.md` §11.4 — the client precedent (emit `.ts`) that task 39 followed for the server.
- `08-stack-and-repo.md` §5 (build/emit conventions), §3.3 (package boundaries).
- `testing-guide.md` T-14 (a check asserts its own denominator), T-14c, T-11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/test-support/` (the gate's natural home) — **contended**; serialize. Coordinate with task 31, which just reworked `sec-meta.ts` in the same package.

## Acceptance

**Observable done-condition:** re-introducing a dangling re-export (or an input `.d.ts` under `src/`) turns a gate **RED**.

- **Falsify it** (§2.11) — this is the whole deliverable. Recreate task 39's bug (rename an emitted `.ts` back to an input `.d.ts`), watch the gate go red naming the specifier; restore → green. A sweep nobody has watched fail is not a gate.
- **Assert the denominator** (T-14): report how many packages, `exports` targets, and emitted `.d.ts` specifiers were checked; fail loudly on zero. **A sweep that silently globs nothing is this repo's signature failure** — and it has bitten twice in the last hour (a QA glob matched 61 of 91 spec files and reported 31 FR ids against a real 578; a coverage regex was newline-blind and fabricated 28 of 70 "findings").
- **Mind the failure direction.** Task 39's own guard taught this: the obvious `IsAny<T> = 0 extends 1 & T` assertion is **dead** against an unresolved re-export, because TypeScript yields *errorType*, which is assignable in **both** directions — review-06 proved it with a control (`IsAny<RealAny>` → TS2322 while both `IsAny<DB> = true` **and** `= false` stayed silent). If your gate reasons about types, **prove which direction it fails in**, with a control.
- **Do not duplicate `typecheck`'s job.** Task 39 already ships `apps/server/test/db-types-reach-consumers.test.ts` for the `DB`-specific case. This gate is the **repo-wide structural** check: does any package promise a type it doesn't emit? Different question, one implementation each (§2.8).

## Note

Filed because review-06 asked for it before merge, correctly citing §2.7. The class has **zero** live instances — this is prevention, not repair, and its priority is LOW for exactly that reason.

But it earns the file rather than a note because of what the one instance cost: it wasn't a test guard passing without testing (this repo has shipped **eight** of those). It was **`tsc` itself** returning green over an entire application for weeks. The other eight were caught by someone running the mechanism; this one was caught only because an agent noticed an expression that typechecked in `apps/server` and failed in `db-server`, **and asked why instead of moving on**.
