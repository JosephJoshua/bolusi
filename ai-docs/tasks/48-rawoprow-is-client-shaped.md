# TASK 48 — `RawOpRow` is client-shaped in three ways; the projection engine cannot read server ops
**Status:** done
**Priority:** **HIGH when task 17 wires the engine server-side** — three separate production bugs, currently unreachable. One of them silently **inverts canonical order**.
**Depends on:** 46
**Blocks:** 17

## Goal

Make `RawOpRow` read correctly on the **real `pg` driver** before task 17 wires the projection engine into the server push transaction — or state, in code, that the engine is client-only and enforce it.

## The finding (task 46, deliberately NOT fixed there — and it was right not to)

`RawOpRow` decodes `operations` rows assuming **client** (op-sqlite/better-sqlite3) marshalling. On the real `pg` driver, **three** fields are wrong, and they fail differently:

| field | client (SQLite) | real `pg` | consequence |
| ----- | --------------- | --------- | ----------- |
| `seq`, `timestamp_ms` | `number` | **`string`** (int8) | **`"10" < "9"` is `true`** — canonical order **inverts past seq 9**, silently |
| `payload` | `string` (TEXT) | **parsed object** (jsonb) | `JSON.parse` **throws** on an object |
| `agent_initiated` | `0`/`1` | **`false`/`true`** (boolean) | `false !== 0` → **every op reads back agent-initiated** |

**The first one is the worst.** It doesn't throw, it doesn't error, it produces a *plausible* ordering that is wrong for every log deeper than 9 ops — which is every real log. Canonical order is the property the entire convergence architecture rests on (FR-1118 / `04 §4.2`); tasks 08 and 35 spent enormous effort proving the fold is order-independent, and this would feed it the wrong order to be independent *of*.

The third is the quiet one: `agent_initiated` is part of the fraud model's attribution (`02 §7`, PRD-004). Every op reading back as agent-initiated would corrupt the audit trail in the direction that excuses humans.

**Why task 46 correctly declined to fix it:** casting only the int8 half would leave the other two broken **while implying server-readiness** — the exact "a gate implying coverage it lacks" failure this repo has now shipped nine times. A half-fix here is worse than none, because it removes the signal that anything is wrong.

**Verified unreachable today:** `apps/server` does not wire the projection engine; task 17 is `todo`. So this is latent, not live — but it is positioned exactly where task 17 will step.

## Docs to read

- The `RawOpRow` decoder + `reconstructOperation` in `@bolusi/core` — task 46 fixed the int8 class **at the boundary** (not per-site, §2.8); read its `Int8Value` seam and follow the same shape.
- `ai-docs/tasks/46-*.md` §Outcome — the full class sweep (70 raw `sql<>` sites; 21 asserting `number`; per-site verdicts). This task is its one deliberate exclusion.
- `testing-guide.md` **T-14f** (both engines ≠ both drivers), **T-8** + §2.4 as task 46 amended them, T-11, T-14.
- `05-operation-log.md` §4 (canonical order — the property `seq`-as-string breaks), `02-permissions.md` §7 + PRD-004 (`agentInitiated` attribution).
- `10-db-schema.md` §3 (`server_seq`/`seq` are `bigint`; `payload` is `jsonb`; `agent_initiated` is `boolean` server-side).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **Real Postgres is mandatory** — PGlite reproduces **none** of these three (it returns numbers, and its jsonb/boolean handling differs from `pg`). That is precisely why they survived. Use the per-worktree lane (task 34): `pnpm db:up` (read its output), confirm `attribution OK … owned by '<your project>'` (T-14d), `pnpm db:down` after.

## Acceptance

**Observable done-condition:** reading a server-written op through `RawOpRow` on the **real `pg` driver** yields the same logical operation as reading the same op on the client — proven by a test that fails today.

- **Reproduce all three first** (T-11), on real PG16, each with its own assertion:
  1. Insert ops at seq 9 and 10; sort by canonical order; watch **10 sort before 9**. This is the one to lead with — it is silent and it inverts the architecture's load-bearing property.
  2. Read a `jsonb` payload; watch `JSON.parse` throw.
  3. Insert `agent_initiated = false`; watch it read back **truthy**.
  If any already passes, the premise changed — stop and report.
- **Fix at the boundary, not per-site** (§2.8) — follow task 46's `Int8Value` seam. Per-call-site casts are what produced this class: *one function had the cast, the neighbour twelve lines away didn't*.
- **Falsify each** (§2.11): each fix removed → its real-`pg` test RED; restored → green. **A test that only runs on PGlite/SQLite cannot go red here** — if your test passes with the fix removed, you have written the bug's alibi (task 46 proved this exactly: the same file with the bug fully present went green on PGlite).
- **Assert the driver precondition itself** (T-14, task 46's pattern): the test asserts that int8 *does* arrive as a string / jsonb *does* arrive parsed / boolean *does* arrive as a boolean — so the lane fails loudly the day that coverage evaporates, rather than going green for the wrong reason.
- **Then close the second hole task 46 found**, or say why not: the applier-conformance gate only calls `applyAppendedOp`, so **the pull branch — the sole caller of `highestContiguousServerSeq` — was never executed on either leg.** The gate didn't merely marshal wrong; **it never ran the function.** If task 17 relies on that path, it needs coverage that executes it.
- **Or rule the other way, explicitly.** If the projection engine is client-only by design, then say so **in code** and make it unrepresentable server-side — don't leave a decoder that silently mis-reads server rows for the next agent to wire up. State which you chose and why.
- `pnpm test`, `pnpm test:rls` (real PG16, attributed), `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Outcome

**Ruled: fix, not client-only.** Task 49 wires the engine into the server push transaction, so a
decoder that mis-reads server rows is on its critical path. Fixed at the boundary in task 46's
shape — each field now goes through the shared normaliser for its COLUMN CLASS, and `RawOpRow`'s
raw-`sql<>` annotation was widened from the client's marshalling to the union the drivers actually
produce, so the compiler forces the normalisation instead of believing an assertion. `db.d.ts` had
already derived all three (`seq: Int8`, `payload: Json`, `agentInitiated: Generated<boolean>`).

Reproduced on real PG 16.14 (attributed), each with its own assertion:

| bug | observed on real `pg` | fails |
| --- | --- | --- |
| `seq` int8 → string | `expected [ '10', '9' ] to deeply equal [ 9, 10 ]` | **silently** |
| `payload` jsonb → parsed | `SyntaxError: "[object Object]" is not valid JSON` | loudly |
| `agent_initiated` → boolean | `expected true to be false` | **silently** |

**A fourth, same class, twelve lines away: `location` is `jsonb` server-side too** and was
`JSON.parse`d on the identical assumption. It is not in this task's brief; it is §2.8's point
about what per-site handling does, found only because the fix was made per-class.

**The loud bug masks the silent ones.** With all three present, `JSON.parse(object)` throws inside
`readEntityOps` before any ordering or attribution assertion can speak: the first run was 9 red,
all reporting `SyntaxError`. The inversion is only observable once the jsonb fix is in. Fixing the
loud bug alone would have surfaced the two silent ones with no test watching — which is exactly
why task 46 was right to refuse the half-fix.

**Falsified, each fix independently (rebuild between every cycle — see below):**

| fix removed | PGlite | real `pg` PG16 |
| --- | --- | --- |
| `seq` int8 | **14/14 GREEN** — the alibi | **4 RED** |
| `payload`/`location` jsonb | 9 RED | 9 RED |
| `agent_initiated` bool | 1 RED | 1 RED |

**The task's premise was right about the bugs and wrong about the lanes: PGlite reproduces two of
the three.** Only the int8 one is PGlite-blind — and it is the silent, order-inverting one, so the
conclusion (the file must live next to the real driver) holds for the reason that matters. But
"PGlite reproduces none of these three" is not true, and a future reader should not rely on it.

**A provenance trap worth carrying (§2.1, T-14d's shape).** `@bolusi/core` exports `./dist/*`, and
`pnpm test:rls` — unlike `pnpm test` — does **not** run `tsc -b`. So an edit to `src` is invisible
to the rls lane until rebuilt, while source maps still point stack traces at `src`, making a stale
run look live. The first staged reproduction here was silently testing pristine dist and was
discarded. **Any falsification on the rls lane is worthless without `npx tsc -b` in the cycle** —
without it, "fix removed → still red" and "fix restored → green" are both readings of the same
unchanged bundle. Each cycle above asserts the reverted line is present in `dist` before running.

**T-14g (touched an existing test's fixture):** `seedOperation` gained an optional `overrides` —
additive, so task 46's calls are byte-identical. Proven still load-bearing rather than assumed:
broke its subject (the walk's `int8ToBigInt`) → `projection-int8-marshalling` went **5 red** on
real PG16; restored → green.

### The second hole (T-8's pull branch) — deliberately NOT closed here

`highestContiguousServerSeq` *is* now executed on the real driver by task 46's file. What remains
unexecuted on any Postgres leg is the engine's **pull branch** (`applyPulledOp`), and closing it
needs the server wiring that does not exist yet: a registered manifest, projection tables, and a
watermark store — `createServerWatermarkStore` is task 47's live work, and how the engine is wired
server-side is task 49's design decision. Building a harness for it here would either duplicate or
contradict task 49 and would edit contended code mid-flight (§4). **Task 49 must ship coverage
that executes the pull branch server-side** — the decoder it stands on is now covered; the branch
itself is not.

## Note

Found by task 46 while sweeping the class of its own bug — and its judgment is the reason this is a task rather than a footnote. It could have cast the int8 half, reported "class swept, all sites fixed", and been green. Instead it reported that the other two fields are equally broken and that a partial fix would imply a server-readiness that doesn't exist.

Worth carrying: task 46 also found that **kysely-codegen already derived the truth** — `db.d.ts:190` says `serverSeq: Int8` where `Int8 = ColumnType<string, …>`. The type system knew. A hand-written `sql<{ serverSeq: number }>` assertion overrode it, and `tsc` believed the assertion. The correct answer was in the repo the whole time, discarded by a claim — which is this project's signature failure wearing yet another hat.
