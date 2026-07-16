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

Container start is seconds, not milliseconds; the full suite is already ~600 s and `test:rls` ~70 s for 124 tests. Expect L3 to get slower. **That is accepted.** Mitigations are reuse (`.withReuse()`), template databases, and suite-level (not test-level) containers — not a return to the substitute.

## Consequences

- `testing-guide.md §2` (which **owns** the pyramid and its environments) changes **first**, then the code — its own change-control rule.
- The `08` catalog note *"do not trust WASM as the only RLS witness"* was already half of this ruling. D16 finishes it: WASM is not the witness at all for driver, RLS, or version-sensitive claims.
- Filed as **task 73**.
- **PGlite is not necessarily deleted.** Where it demonstrably proves dialect-neutrality that real PG also proves, it may stay as a fast pre-filter — but it stops being the sole witness for anything, and every gate states which Postgres and which client it ran (T-14f rule 3).
