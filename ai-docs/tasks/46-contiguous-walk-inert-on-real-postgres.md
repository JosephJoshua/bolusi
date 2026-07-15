# TASK 46 — `highestContiguousServerSeq` never advances on real Postgres: `int8` arrives as a string
**Status:** in-review
**Priority:** **HIGH** — a silent, total failure of the server-side projection watermark on the production engine. Fails *quiet*, not closed: no error, no red test, the watermark simply never moves.
**Depends on:** 08

## Goal

Make the contiguous-serverSeq walk work on the engine production actually runs on, and close the reason every existing test lane is blind to it.

## The bug

`packages/core/src/projection/oplog-source.ts:167-181`:

```ts
const result = await sql<{ serverSeq: number }>`      // ← the type is ASSERTED, not derived
  SELECT server_seq AS server_seq FROM operations
  WHERE server_seq > ${from} ORDER BY server_seq
`.execute(db);
for (const row of result.rows) {
  if (row.serverSeq === watermark + 1) {              // "1" === 1  →  false. Forever.
    watermark = row.serverSeq;
```

`operations.server_seq` is `bigint` (`10-db §3`). The **real `pg` driver returns `int8` as a string** — int8 exceeds JS's safe integer range, so node-postgres refuses to lossily coerce it. Strict `===` therefore never matches, the loop breaks at the first row, and the function returns `from` unchanged.

**Verified empirically by the orchestrator on real PostgreSQL 16.14** (not reasoned about):

```
bigint -> value="1"  typeof=string
int4   -> value=1    typeof=number
THE COMPARISON: (row.serverSeq === watermark + 1) with watermark=0  ->  false
```

**Consequence:** `applied_server_seq` never advances server-side. Every server projection stays pinned at its starting watermark. Task 17 consumes this path; task 16 had to route its PG16 test around it (advancing the watermark via the store directly, and saying so).

**The TypeScript annotation is part of the bug.** `sql<{ serverSeq: number }>` is a raw-SQL type assertion — the compiler believes it and typechecks clean. This is the same family as task 39 (`DB` is `any` across `apps/server`): *a type that was declared rather than derived tells you nothing about runtime.*

## Why every lane missed it — the part worth more than the fix

| lane | driver | `int8` returns |
| ---- | ------ | -------------- |
| `@bolusi/core` unit tests | better-sqlite3 | **number** |
| applier-conformance (the **T-8 both-engine gate**) | PGlite | **number** |
| production + `test:rls` | **real `pg`** | **string** ← the only one that reproduces |

**The both-engine gate cannot catch this, by construction.** T-8 exists to prove appliers are dialect-neutral, and it does — but it proves *SQL dialect* neutrality, not *driver marshalling* equivalence. **PGlite is not a faithful proxy for `pg`.** It embeds a real PostgreSQL, so the SQL is honest; but it is a different client, and the client is what decides what JS type you get back. So a gate labelled "SQLite **vs Postgres**" is really "SQLite vs *a* Postgres, over a driver production never uses."

Recorded as **testing-guide T-14f**. Note the near-miss that makes the point: review-03, reviewing task 11, spotted this exact mechanism — *"the `Number()` comment overstates its evidence: through PGlite it comes back as a number… it IS load-bearing against the real `pg` driver"* — and correctly sized the instance it was looking at as a **nit**, because task 11's `watermarks.ts` **does** carry the `Number()` cast (lines 82-83) and was therefore safe. The mechanism was identified; the **class** was never swept. One function had the cast; the neighbouring one did not.

## Docs to read

- `packages/core/src/projection/oplog-source.ts` :167-181 (the walk) — and `watermarks.ts` :76-83, which already does this correctly and whose comment explains why. Read both together; the fix already exists, twelve lines away.
- `packages/core/src/projection/oracle.ts:59` — the existing precedent for the *safe* shape: `value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString()`. Decide whether the walk needs that or plain `Number()`, and say why.
- `04-module-contract.md` §4.3 (contiguity semantics), `10-db-schema.md` §3 (`server_seq bigint`, gapless per tenant), §9.1 (the watermark scalars).
- `testing-guide.md` **T-8** (the both-engine rule this task amends), **T-14f** (this incident), T-13 (interrogate the oracle), T-12 (the class, not the instance).
- `ai-docs/tasks/42-*.md` — the related `Number()` comment nit from the same mechanism.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **Real Postgres required.** PGlite cannot reproduce this — that is the whole point. Use the per-worktree lane (task 34): `pnpm db:up`, then confirm the run printed `attribution OK … owned by '<your project>'` before believing any number (T-14d).

## Files / modules touched

- `packages/core/src/projection/oplog-source.ts`. **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize.
- `packages/core/test/projection/**` + possibly a new real-`pg` lane (see Acceptance).
- `ai-docs/testing-guide.md` T-8 — doc-first if the both-engine rule's wording changes.

## Acceptance

**Observable done-condition:** a test running against **real `pg`** proves the watermark advances across a contiguous run — and fails if the cast is removed.

- **Reproduce first** (T-11): on real PG16, call `highestContiguousServerSeq(db, 0)` with contiguous ops at server_seq 1,2,3 and watch it return **0**. That silent zero is the bug. If it returns 3, the premise is wrong — stop and report.
- **Fix the walk.** Justify `Number()` vs `oracle.ts:59`'s safe shape: `server_seq` realistically stays under 2^53, but `bigint` was chosen deliberately and a silent lossy coercion at 2^53 would be this same bug wearing a different hat. State the reasoning in the code, and make the claim one a test can check.
- **Falsify** (§2.11): remove the cast → the real-`pg` test goes red (watermark 0 instead of 3); restore → green. **A test that only runs on PGlite/SQLite cannot go red here** — if your new test passes with the cast removed, you have written the bug's own alibi. Prove it fails.
- **SWEEP THE CLASS — this is the deliverable, not the one-line fix** (T-12). Enumerate **every** raw-`sql<{...: number}>` read of an `int8`/`bigint` column in `@bolusi/core` and `@bolusi/db-server`, and every place a `bigint` crosses into JS arithmetic or `===`. `watermarks.ts` is safe; `oplog-source.ts` was not; **name the total and the verdict for each** (T-14 — a sweep must assert its own denominator). Any raw-SQL result type asserting `number` over an int8 column is this bug, present or latent.
- **Close the lane gap, or state plainly why not.** The reason this shipped is that **no test lane uses the production driver**. Either add a real-`pg` leg to the projection suite (the `test:rls` lane already has attributed real PG16), or record explicitly in T-8 that the both-engine gate does **not** cover driver marshalling and name what does. Do not leave the gate implying a coverage it lacks — that is the exact failure this repo has now shipped nine times.
- `pnpm test`, `pnpm test:rls` (real PG16, attributed), `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Outcome

Reproduced on real PG 16.14 (attributed): the walk returned **0** over contiguous ops at 1,2,3. Fixed by
widening the raw-SQL annotation to the drivers' truth (`Int8Value = string | number | bigint`) and
normalising through one seam, `packages/core/src/projection/int8.ts`. The walk now runs in **bigint** and
narrows exactly once on the way out, so it is exact over the column's range and a value past 2^53 throws
instead of rounding. `watermarks.ts` was moved onto the same seam: it was right about the live bug and
silently lossy at 2^53, and a per-call-site convention is what let the neighbouring function ship without
it (CLAUDE.md §2.8).

Lane gap closed by construction: `packages/db-server/test/projection-int8-marshalling.test.ts` runs the
walk on the **real `pg` driver** via `pnpm test:rls`. It asserts its own coverage (T-14) — the int8-arrives-
as-string precondition is a test, so the file fails loudly the day that stops being true rather than
going green for the wrong reason. Falsified: cast removed → 4 red on real PG16, green on PGlite with the
bug fully present. T-8 + §2.4 amended to state the gate covers dialect, not driver marshalling.

The seam is **exported** (`int8ToBigInt`/`int8ToNumber`/`Int8Value` from `@bolusi/core`) specifically so
task 47's `createServerWatermarkStore` can adopt it instead of re-rolling its own `Number(...)`. A private
normaliser would have guaranteed the copy — i.e. re-created this bug — which is the opposite of the point.

**Sweep denominator (corrected):** **65** raw `sql<>` call sites in `@bolusi/core` + `@bolusi/db-server` at
this branch's merge-base; **66** after this change (the new test adds one). Not 70 — that was a naive
line-grep counting this change's own 4 *comment* mentions of `sql<`. **21** assert a `number` field.

### The 2^53 test was inert, and went inert *because the fix landed* (review F1)

Worth reading before touching that block. It first passed `from = 2^53` — which is itself **not** a safe
integer (`MAX_SAFE` = 2^53 − 1), so the walk threw on its own `from` parameter at its first statement and
never read a row; the loose `/server_seq/` oracle matched that unrelated error just as happily as the
intended one (T-13). Proven inert: deleting the seeded row left the suite 8/8 green.

It was **not born inert**. Against the first cut of the fix — which narrowed per row — the seeded row *was*
read and *did* throw, and this test is what caught that flaw. Fixing the flaw (walk in bigint, narrow once
on the way out) moved the throw from "per row" to "on the way out", and the test silently stopped reaching
it. **A guard that stopped working because the fix landed**: the shape changed underneath it and nothing
re-asked what it still proved. Distinct from every prior instance in T-11, which never worked at all.

Now: `from = ...989` (safe) with contiguous ...990/991/992, oracle tightened to `/exceeds/`, a positive
control (a safe walk returns ...988 without throwing, so "it throws" cannot degenerate into "big numbers
throw"), and the `from`-param guard pinned to its own `/not a safe integer/` claim. Falsified three ways on
real PG16: narrowing throw removed → red; **seeded row deleted → red** (the check that proves it is not
inert again); both restored → 10/10 green.

### Residual finding — NOT fixed here, needs an owner (task 17 is the natural one)

`oplog-source.ts`'s `RawOpRow` / `reconstructOperation` is **client-shaped by construction** and cannot
read the SERVER op log as written — three divergences, not one:

| field | client (SQLite) | server (10-db §5) | asserted | on real `pg` |
| --- | --- | --- | --- | --- |
| `seq`, `timestamp_ms` | INTEGER → number | `bigint` | `number` | string → `"10" < "9"` is **true**, canonical order silently inverts past seq 9 |
| `payload`, `location` | `text` | `jsonb` | `string` | driver returns a parsed **object**; `JSON.parse(object)` throws |
| `agent_initiated` | `integer` 0/1 | `boolean` | `number` | `false !== 0` → **every op reads back agent-initiated** |

Not reachable today (`apps/server` does not wire the projection engine; task 17 is `todo`), which is why it
is reported rather than half-fixed: casting only the int8 half would leave the other two broken while
implying a server-readiness that does not exist — the same "gate implying coverage it lacks" failure. The
real question is a design one: does server projection read the server op log through this function at all,
given jsonb/boolean? The applier-conformance fixture models the CLIENT DDL verbatim, so T-8 will not answer it.

## Note

Found by task 16, which probed the production engine directly instead of trusting its green PGlite suite, and **correctly declined to fix it** — `@bolusi/core` was contended with task 14 live (§4/§6). It routed its own PG16 test around the broken function and said so in its report rather than quietly using the workaround as evidence.

The uncomfortable summary: this bug survived task 08's implementation, task 08's review (200 convergence checks), task 11's implementation, task 11's review — which *identified the exact mechanism* and sized the instance in front of it correctly — and the orchestrator's own merge verification of both. It survived because **every one of those greens came from an engine that isn't the one that runs in production**, and nobody asked what the gate's "Postgres" actually was until someone connected the real driver.
