# TASK 74 — 11 raw-`sql<T>` readers are green only because `CamelCasePlugin` is wired, and nothing asserts that dependency

**Status:** in-progress
**Priority:** **MEDIUM** — zero live bugs today (every production Kysely wires the plugin). It is a **latent trap with a silent failure mode**, and the repo has already paid for this exact class three times (tasks 39, 46, 18).
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (review-18, task 18 review, 2026-07-16 — orchestrator verified the two worst)

A raw `sql<T>` annotation is **a claim `tsc` accepts without evidence**. Task 18 found a new dimension of it: **`CamelCasePlugin` rewrites raw `sql` result KEYS, not just builder identifiers.** So the annotation's key names are load-bearing runtime behaviour supplied by a plugin — and if the plugin is absent, every read is `undefined`.

**11 sites read raw SQL whose keys only resolve because the plugin is wired**, all pre-existing (none are task 18's):

`sync/state.ts:60` · `sync/push.ts:51,251` · `sync/pull.ts:411` · `sync/devices.ts:58` · `sync/quarantine.ts:134` · `projection/oplog-source.ts:165,190,196,229` · `core/.../watermarks.ts:77` · `db-server/watermarks.ts:51`

**The two worst, verified by the orchestrator:**

| site | code | why it's bad |
| ---- | ---- | ------------ |
| `projection/oplog-source.ts:229` | `sql<{ serverSeq: Int8Value }>` over `SELECT server_seq AS server_seq` | The annotation is **camelCase**; the SQL aliases to **snake**. It resolves *only* via the plugin. The `AS server_seq` self-alias **looks like the T-14f fix and is a no-op** — and this is **task 46's own fix site**, so the next reader sees a hardened line and moves on. |
| `sync/pull.ts:411` | `sql<{ maxSeq: number \| null }>` over `AS max_seq`, then `Number(rows[0]?.maxSeq ?? 0) + 1` | Worse than `NaN`. A missing key → `?? 0` → **returns a plausible `serverSeq` of `1`** instead of a loud failure. A silent wrong sequence number, not a crash. |

**Why "zero live bugs" is not "no problem":** both non-test Kysely constructions wire the plugin (`db-client/src/connection.ts:185`, `db-server/src/db.ts:31`), and no production path runs raw SQL without it — **today**. The trap fires the moment someone builds a Kysely without it: a new test harness, a new lane (task 73 is about to build one), a refactor, or a package that constructs its own handle. Nothing warns; the reads just become `undefined`, and — per `pull.ts:411` — may launder into a plausible value.

**This class has now cost the repo three times:** task 39 (`DB` resolved to `any`, so `tsc` checked nothing across `apps/server`), task 46 (`sql<{serverSeq: number}>` over int8 → `"1" === 1` false forever, watermark never advanced), task 18 (`sql<{byte_size}>` → `byteSize` → **`NaN` on the wire**). Same mechanism every time: **a hand-written type argument that `tsc` believes and never checks.**

## Acceptance

**Observable done-condition:** either the readers stop depending on an unasserted plugin, or the dependency is asserted somewhere that fails loudly when it stops holding.

- **Re-derive the 11 sites yourself** (T-14/T-16 — do not take this file's list; it is a mention). Report your denominator and how you found them. The orchestrator's `sql<{…snake_case…}>` grep found **zero** — the live shape is the **inverse** (camelCase annotation over a bare/snake select), so a naive grep misses all 11. Say what your instrument can and cannot see.
- **Pick one and say which:**
  - **(a) Make the sites self-sufficient** — explicit aliases (`server_seq AS "serverSeq"`), which are **inert under both wirings** (task 18's fix; verified idempotent against real kysely `transformResult`). Then the plugin is an optimisation, not a load-bearing secret.
  - **(b) Assert the dependency** — a test that constructs a Kysely **without** the plugin and proves these readers fail **loudly** (not silently). If you choose this, the assertion must fail when the plugin is removed — **falsify it** (§2.11).
  - **(a) is the orchestrator's lean**: it removes the coupling instead of documenting it, and §2.11 favours closing by construction over a guard someone must maintain. But (b) has merit if the plugin is genuinely architectural (`10-db §11.4` calls it "the runtime half of the client codegen contract") — in which case say so and make the contract testable.
- **Kill `pull.ts:411`'s `?? 0` laundering regardless of which you pick.** A missing `MAX(server_seq)` and a table whose max is `0` are different facts, and the code cannot currently tell them apart — it returns `1` for both. Decide what a missing key *should* do (it should throw) and make it do that.
- **Fix `oplog-source.ts:229`'s self-alias specifically**, and note it in the code: `AS server_seq` reads as deliberate hardening and is a no-op. Leaving a decoy at task 46's own fix site is how the next sweep skips it (T-15: the comment/appearance is the guard).
- **Coordinate with task 73** (§4): it is building a real-PG16 lane and will construct Kysely handles. **If it builds one without the plugin, these 11 sites break silently in the new lane** — which is either this task's best falsification or its worst surprise, depending on ordering. Say which of you goes first.
- **Falsify whatever you land**: remove the plugin from a construction → the readers fail **loudly**; restore → green. Report as "broke X, saw Y fail, reverted", not "the tests pass".
- `pnpm test`, `pnpm test:rls`, `pnpm lint`, `pnpm typecheck` green — **read the output, not the exit code** (§2.1). **T-18**: a "completed (exit code 0)" notification has **four times** this session described a **reaped** run with no `Test Files N passed` line; suites have **wedged at the vitest banner under load**. `wc -c` a fast log; know your denominator.

## Note

Found by **review-18 sweeping the class after task 18 fixed its instance** — the T-12 move ("test the class, not the instance") producing exactly what it's for: the implementer's bug was one site, the class was twelve. The orchestrator's own sweep for the same class searched the *wrong shape* (`sql<{snake_case}>`) and found zero, then reported "zero live instances" — **a confident, specific, wrong number, from an instrument aimed one character off.** That is T-16's whole thesis, and it is the third time this session the orchestrator's grep answered a question it wasn't asked.

Worth carrying: `oplog-source.ts:229` is the sharpest artefact here. It sits under a comment explaining task 46's int8 bug, carries `Int8Value` (46's fix), and aliases `AS server_seq` — every signal says *"this line has been thought about."* It has. It is still wrong in a second dimension nobody was looking at, because the fix for one silent failure was written in the presence of another. **A hardened line is not a verified line**; the hardening is evidence about the bug someone found, not about the bug they didn't.
