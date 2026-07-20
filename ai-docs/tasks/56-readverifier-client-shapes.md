# TASK 56 — `readVerifier` asserts client shapes over server types: the PIN-verifier "newest" decision can invert silently
**Status:** done
**Priority:** MEDIUM (latent — `apps/server` doesn't call it yet) but it is an **auth surface**, so §2.5 applies: adversarial tests ship before review.
**Depends on:** 48

## The finding (task 48, deliberately not fixed there)

`packages/core/src/auth/repo.ts:165` — `readVerifier` asserts:
```ts
params: string, asOfSeq: number, asOfTimestamp: number
```
over a table that is, **server-side**:
```
params: Json, asOfSeq: Int8, asOfTimestamp: Int8
```

And `packages/core/src/auth/verifier.ts:215` feeds `asOf` into **`compareCanonicalOrder`**.

**This is the identical silent inversion task 48 just fixed in `RawOpRow`** — `"10" < "9"` is `true`, so ordering inverts past 9 — except here it decides **which PIN verifier is newer**. A wrong answer picks a **superseded verifier**, which is an authentication decision, not a display bug. `params: Json` carries the jsonb class too (`JSON.parse` on an object throws).

**Why task 48 declined to fix it, and why that was right:** it's an auth surface with its own adversarial-test obligation (§2.5), and task 48's fence was the op-log decoder. A drive-by cast would have shipped an auth change with no adversarial coverage — and the whole lesson of the `RawOpRow` class is that **a partial fix implies a readiness that doesn't exist**.

**Latent, not live:** `apps/server` does not call `readVerifier` today. It becomes live the moment the server reads verifiers — which is on task 13's surface and in task 28's sweep path.

## Docs to read

- `packages/core/src/auth/repo.ts:165`, `verifier.ts:215` (the `compareCanonicalOrder` feed).
- `packages/core/src/projection/int8.ts` + `columns.ts` — **the seams already exist**: `int8ToNumber`, `jsonColumnToObject`, `boolColumnToBoolean`, all exported from `@bolusi/core` (task 48). **Use them. Do not write a fourth cast** — "one function had the cast, the neighbour didn't" is the condition tasks 46/48 exist to abolish (§2.8).
- `ai-docs/tasks/48-rawoprow-is-client-shaped.md` §Outcome — the same three classes, already diagnosed, with the falsification pattern to copy.
- `05-operation-log.md` §4 (canonical order), `api/02-auth.md` §6.5 (verifier lifecycle, greatest-`asOf` merge).
- `testing-guide.md` T-14f (PGlite is not `pg` — **and note task 48's correction: PGlite reproduces the jsonb and boolean classes, only the int8 one is PGlite-blind**), T-11, T-14b.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **Real Postgres for the int8 leg** (task-34 lane; confirm `attribution OK` — T-14d). **Read task 55 first if it hasn't landed**: `test:rls` does not rebuild, so an rls falsification without an explicit `tsc -b` reads a **stale bundle** and looks live.

## Acceptance

**Observable done-condition:** on the real `pg` driver, verifier ordering picks the genuinely newest verifier — and a test fails if the normalization is removed.

- **Reproduce first** (T-11), on real PG16: two verifiers with `asOfSeq` 9 and 10; assert the "newest" decision picks **10**; watch it pick **9**. That silent inversion is the bug. Lead with it — it decides authentication.
- **Fix at the boundary using the existing seams**; do not re-roll casts.
- **Falsify each class** (§2.11): int8 removed → real-`pg` test RED (**and confirm it stays GREEN on PGlite — that's the alibi task 48 proved**, and if your test goes red on PGlite you've tested something else); jsonb removed → red; restore → green.
- **§2.5 — adversarial tests before review.** This is an auth decision. Beyond ordering: a tampered `asOf`, equal `asOf` values, a `params` blob that isn't an object, a verifier row for another user. Every deny needs a **positive control** (the legitimate newest verifier IS selected), or a fix that rejects everything looks identical to a fix that works (T-14b).
- **Sweep the class once more** (T-12): task 48 found this by reading `repo.ts` after fixing `oplog-source.ts`. **Is there a third decoder?** Enumerate every raw-`sql<>` in `@bolusi/core` asserting a client shape over a server-typed column; name the total and the verdict per site. Task 46 counted **65** raw sites / **21** number-asserting at its merge-base — start from its table, then re-derive rather than trust it (that denominator was wrong twice before it was right).
- `pnpm test`, `pnpm test:rls` (real PG16, attributed), `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

The fourth instance of one class, found by the agent that fixed the third — and it reported rather than fixed, because the auth surface carries an obligation its fence didn't cover.

Worth carrying from task 48's report: **the loud bug masked the silent ones.** With all three classes present in `RawOpRow`, `JSON.parse` threw inside `readEntityOps` before any ordering or attribution assertion could speak — the first run was 9 red, all `SyntaxError`. **Fixing jsonb alone would have surfaced the two silent bugs with nothing watching them.** That is the vindication of task 46's refusal to half-fix, and the reason this task must handle all three of its classes together.
