# D16 — Integration and E2E tests run against REAL dependencies (testcontainers), not in-process substitutes

**Date:** 2026-07-16
**Status:** Accepted — **owner directive**
**Supersedes:** `testing-guide.md §2:87`'s "PGlite is the fast loop, real Postgres is the drift check" tradeoff, to the extent the two conflict.

## The directive

> "for integration/e2e tests you should make them as realistic as possible, e.g. using testcontainers"

## Why this is the right call, in this repo's own measured evidence

This is not a preference; the substitute has already cost us. Every item below is a recorded incident, not a hypothetical:

| evidence | what the substitute did |
| -------- | ----------------------- |
| **T-14f** (task 46/48, measured) | The int8 marshalling bug: **PGlite 14/14 GREEN vs real `pg` 4 RED.** PGlite catches the classes that *throw* and is blind to the one that **returns a plausible wrong answer**. `highestContiguousServerSeq` compared `"1" === 1` → the server watermark **never advanced in production**, silently, with no red test. |
| **T-14b** (recorded incident) | PGlite connections run as the **superuser/table owner**, and **owners bypass RLS by default** — so a naive RLS test on PGlite passes **vacuously**. Tenant isolation, our most important invariant, tested by a lane structurally incapable of failing. |
| **version drift** | PGlite embeds **PG18**. Production is **PG16**. The lane's name says "Postgres"; it is a different major over a driver production never uses. |

**The generalisation (T-14f):** *"both engines" is not "both drivers."* A substitute proves SQL **dialect** neutrality honestly and proves **nothing** about the client that marshals the bytes — and the marshalling bugs are the silent ones.

## What this means, normatively

1. **An integration/E2E test's dependencies are the real thing, in a container, pinned to the production version.** For Postgres that is the `postgres:16` image over the real `pg` driver — never PGlite, never a WASM/in-process embed, never a mock.
2. **Speed is not a reason to substitute.** It is a reason to make the real thing faster (reuse, parallel suites, snapshot/template databases). The fast-but-wrong lane has now shipped two silent production bugs; the time it saved was borrowed against them.
3. **A substitute may remain ONLY where it proves something the real thing also proves**, and its scope is stated in the gate (T-14f rule 3: *"when a gate's name says Postgres, write down WHICH Postgres and over WHICH client"*). A substitute may never be the **sole** witness for a claim about the production driver, RLS, or a version-sensitive behaviour.
4. **The same principle applies beyond Postgres**: the chaos harness (task 26) and any future E2E drive real components over real transports wherever a container can host them.

## Why testcontainers specifically, over the bespoke compose lane

`scripts/db-lane.mjs` (task 34) already runs **real PG 16.14** with per-worktree ephemeral ports and a `bolusi.db_owner` attribution GUC. It is good, and it was built by hand in response to a real incident: a fixed host port meant a failed `db:up` **silently resolved to a peer worktree's database**, and task 13's "82/11 on real PG16" merge-gate number was produced by task 05's leaked container — *a real number with fictional provenance*.

Testcontainers closes that class **by construction rather than by discipline** — which is exactly the argument `db-lane.mjs`'s own header makes about §2.1 ("the rule was already written and it did not save anyone"):

- **Ryuk** — a reaper sidecar that removes containers when the test process dies, however it dies. The leaked container that served the fake green could not have survived.
- **Ephemeral ports by construction** — `getConnectionUri()` is derived from the started container; there is no fixed port to fall back to. (db-lane derives this by hand today; testcontainers makes it the only option.)
- **Pinned image** — `new PostgreSqlContainer("postgres:16")` states the production major in code, where a test can read it.
- **Lifecycle owned by the suite**, not by a developer remembering `db:down`.

**Non-owner role is mandatory and does not come free.** Testcontainers' default user is the DB owner, so an RLS test on it is vacuous **for the same reason PGlite was** (T-14b). The container must provision `bolusi_app` (NOBYPASSRLS) and the suite must connect as it — otherwise we have swapped one vacuous-RLS lane for another and called it progress.

## Cost, stated honestly

~~Container start is seconds, not milliseconds… Expect L3 to get slower. **That is accepted.** Mitigations are reuse (`.withReuse()`)…~~

**RETRACTED — both halves were wrong, measured by task 73 (2026-07-16):**

1. **It is faster than the lane it replaces — but the orchestrator's explanation of WHY was wrong, twice, and the honest table is below.** Measured by review-73 and reproduced by the orchestrator, same tree, each `EXIT=` read:

   | lane | wall | tests |
   | ---- | ---- | ----- |
   | compose real-PG (`test:rls`, the lane replaced) | **216.72 s** | 133 |
   | **testcontainers real PG (new)** | **45.35 s** | 133 |
   | PGlite serial (as configured) | 46.16 s | 130 + 3 skipped |
   | PGlite **`--fileParallelism`** (one flag) | **13.94 s** | 130 + 3 skipped |

   So: **4.8× faster than the compose real-PG lane** (the honest comparison, and better than first claimed), **1.02× vs serial PGlite**, and **~3× SLOWER than parallelized PGlite.**

   **~~The substitute's real price was that PGlite boots a WASM Postgres per file and FORCED `fileParallelism: false`.~~ RETRACTED — this is the orchestrator's SECOND wrong cause for the same phenomenon.** `packages/db-server/vitest.config.ts` says plainly: *"each file boots its own in-memory postgres; **serialising costs a little time and buys identical behaviour across both lanes**."* **PGlite never needed serialisation.** It was serialised **deliberately, for consistency with the shared-DB postgres lane** — and one flag proves it (46 s → 13.94 s, same 130 tests, `EXIT=0`).

   **The pattern, recorded because it is the point of this whole document:** the first wrong cause was *"the machine is oversubscribed (load 15–20)"* — measured: **75% idle, 48 cores, 2 running processes**. The second was this one. **Both times the author asserted a plausible mechanism instead of running the one-line experiment that settles it** (`top`; `--fileParallelism`). A mechanism that *sounds* causal is a hypothesis (T-15/T-16), and this decision argues for mechanism over discipline while its own cost section was written from two un-run guesses.

   **What the speed change actually buys:** it removes the *compose* lane's 216 s, and it makes real-PG affordable enough that fidelity costs ~nothing versus the substitute. That is a real and sufficient result. It is **not** a general speedup, and **task 81 must not cite "130 s → 49 s" to predict `apps/server`'s win** — `apps/server` is on PGlite, where that delta is ~0%. It should still move, for **fidelity** (D16 rule 1), and it will likely win wall-clock because its per-file cost is WASM-boot-plus-migrate which template cloning removes — but that is a hypothesis to measure, not a number to inherit.
2. **`.withReuse()` and Ryuk are MUTUALLY EXCLUSIVE, and recommending reuse here silently disabled the one benefit this decision calls structural.** testcontainers 12.0.4 returns from `reuseOrStartContainer` **before** `getReaper()` and never applies the `session-id` label Ryuk reaps by. Confirmed on this box: a reused container 13 days old carrying a `container-hash` label and **no `session-id`**. So reuse buys ~2 s and **re-creates the exact leak class (T-14d) that Ryuk was chosen to close by construction**. **Rejected.**

**That second error is this decision's own class, authored by its author.** D16 argues for mechanism over discipline, names Ryuk as the mechanism, and then recommended the one option that turns Ryuk off — with nothing to notice, because a reused container looks identical to a fresh one until it outlives its session. It was caught by an implementer reading testcontainers' source rather than trusting this file (§2.1). **A recommendation is a mention, not a producer** (T-16).

**The honest cost, restated:** `pnpm test` now requires Docker. That is the real price and it is accepted. Container boot is ~17 s, once.

## Consequences

- `testing-guide.md §2` (which **owns** the pyramid and its environments) changes **first**, then the code — its own change-control rule.
- The `08` catalog note *"do not trust WASM as the only RLS witness"* was already half of this ruling. D16 finishes it: WASM is not the witness at all for driver, RLS, or version-sensitive claims.
- Filed as **task 73**.
- **PGlite is not necessarily deleted.** Where it demonstrably proves dialect-neutrality that real PG also proves, it may stay as a fast pre-filter — but it stops being the sole witness for anything, and every gate states which Postgres and which client it ran (T-14f rule 3).
