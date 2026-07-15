# TASK 48 — `RawOpRow` is client-shaped in three ways; the projection engine cannot read server ops
**Status:** todo
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

## Note

Found by task 46 while sweeping the class of its own bug — and its judgment is the reason this is a task rather than a footnote. It could have cast the int8 half, reported "class swept, all sites fixed", and been green. Instead it reported that the other two fields are equally broken and that a partial fix would imply a server-readiness that doesn't exist.

Worth carrying: task 46 also found that **kysely-codegen already derived the truth** — `db.d.ts:190` says `serverSeq: Int8` where `Int8 = ColumnType<string, …>`. The type system knew. A hand-written `sql<{ serverSeq: number }>` assertion overrode it, and `tsc` believed the assertion. The correct answer was in the repo the whole time, discarded by a claim — which is this project's signature failure wearing yet another hat.
