# TASK 73 — L3 integration runs on a substitute that has already shipped two silent production bugs; move it to real PG16 via testcontainers (D16)

**Status:** todo
**Priority:** **HIGH** — not a hypothetical. The substitute lane has been **measured** missing exactly the bug class that fails silently, and it makes our most important invariant (tenant isolation) untestable-by-construction. Owner directive, 2026-07-16.
**Depends on:** — (34 landed the attributed real-PG lane this builds on)
**Blocks:** —
**SEC ids owned by THIS task:** none — but see the RLS section; this task makes SEC-TENANT-* legs *meaningful*, it does not claim them.

## The ruling

Read **`ai-docs/decisions/2026-07-16-integration-tests-run-real-dependencies.md` (D16)** first — it is an owner directive and it is the whole premise of this task:

> "for integration/e2e tests you should make them as realistic as possible, e.g. using testcontainers"

## The finding — the substitute's failures are recorded, not theoretical

| # | evidence | what happened |
| - | -------- | ------------- |
| 1 | **T-14f** (tasks 46/48) | int8 marshalling: **PGlite 14/14 GREEN, real `pg` 4 RED.** The production watermark **never advanced**, silently. PGlite catches what *throws*; it is blind to what *returns a plausible wrong answer*. |
| 2 | **T-14b** | PGlite connects as the **table owner**, and **owners bypass RLS**. A naive RLS test on it passes **vacuously** — tenant isolation tested by a lane that cannot fail. |
| 3 | version | PGlite embeds **PG18**; production is **PG16**. |

**378 tests** currently run on this substitute (`pnpm test:server` → `--project server`). The T-8 applier-conformance gate uses it as its "Postgres" leg.

## Scope

**In:** the L3 server-integration lane (`--project server`) and the T-8 conformance gate's Postgres leg move onto **real PG16 in a container over the real `pg` driver**. Introduce `testcontainers` (`PostgreSqlContainer`), pinned to the production major.

**Out:** the client SQLite lane (op-sqlite/better-sqlite3 IS the production client — already real); mobile/UI lanes; the chaos harness (task 26 — D16 applies to it, but it is not this task); deleting PGlite outright (see "PGlite's residual role").

## Docs to read

- **D16** (above) — the directive and its reasoning.
- `ai-docs/testing-guide.md` **§2** (the pyramid + environments — **this doc OWNS them and its change-control says: change the doc first, then the code**), §2.4 (the conformance suite), §2.5, and **T-8 / T-14b / T-14d / T-14f** — the four rules this task's evidence comes from. T-8's stated scope-limits and T-14f's rule 3 must be **rewritten**, not merely satisfied: they currently document the gap this task closes.
- `scripts/db-lane.mjs` — **read its header in full before touching anything.** It is the existing attributed real-PG16 lane (task 34) and it exists because a fixed host port let a failed `db:up` resolve to a *peer worktree's database*, producing a real number with fictional provenance. Whatever you build must preserve **every** property it bought: ephemeral per-worktree ports, a fatal `db:up`, and the `bolusi.db_owner` attribution GUC.
- `ai-docs/08-stack-and-repo.md` §2 (catalog/pins — its PGlite row already says *"do not trust WASM as the only RLS witness"*), §5.6 (CI stages), §3.3.
- **testcontainers-node docs via Context7 — read them yourself, do not trust this file's API sketch** (§2.1, and CLAUDE.md §1: verify current library docs before using an API — training data drifts). Confirmed at filing: `new PostgreSqlContainer("postgres:16")`, `.start()`, `.getConnectionUri()`, `.withReuse()`, default wait `Wait.forAll([forHealthCheck, forListeningPorts])`, 120 s startup timeout, and **Ryuk** for orphan reaping.

## THE STRUCTURAL BLOCKER THIS TASK MUST OWN — `apps/server` cannot reach real PG16 at all

**Found independently by two agents from opposite directions** (review-49 auditing task 49; impl-17 building task 17), then verified by the orchestrator against the tree. That convergence is what makes it structural rather than an oversight:

| fact | evidence |
| ---- | -------- |
| `pg` is granted to **`db-server` only** | `08-stack-and-repo.md §3.3:164` — `\| \`db-server\` \| \`core\`, \`schemas\`, \`kysely\`, \`pg\` \|`. There is no row granting `apps/server` `pg`, and `apps/server/package.json` has **no `pg` dependency**. |
| the real-PG lane sees **only** `db-server` | `test:rls` = `… vitest run --project db-server`. Nothing else. |
| the code says so | `apps/server/test/integration/oplog/helpers.ts` header: *"WHY PGLITE (not the db-server test:rls Postgres lane): `pg` is boundary-locked to …"* |

**So D16's rule — "a substitute may never be the sole witness for a claim about the production driver, RLS, or a version-sensitive behaviour" — is currently unsatisfiable for every `apps/server` integration test.** The push pipeline, the validation stages, the conflict-detection engine, the projection-apply step: all live in `apps/server`, all can only be tested on PGlite today. This is not something an individual task can fix without either moving `pg` across a boundary lint or inventing a second real-PG lane — **both of which are this task's to decide, and §2.8/§4 violations for anyone else.**

**The current workaround, and why it is not a solution:** tasks 47, 49, and 17 all home their **marshalling-sensitive primitive** in `@bolusi/db-server` so `test:rls` executes the *exact production code* rather than a copy. That is genuinely good — it is why task 49's `createServerProjectionEngine` and task 47's watermark store are covered on real PG16 — and impl-17 went further, keeping a `serverSeq > last_pull_cursor` comparison **entirely in SQL** so the marshalling class cannot arise by construction. But it means coverage is the **UNION of two lanes** (pipeline-calls-X on PGlite; X-on-real-PG in db-server), and **no single test traverses the production path end-to-end on the production driver**. A union is not an integration test; it is two halves and an assumption about the seam between them.

**Decide and state which** (this is the task's central architectural call, not a detail):
- **(a) Give `apps/server` a test-only real-PG lane.** Needs an `08 §3.3` change (spec-first) and a rule that keeps `pg` out of `apps/server`'s *production* dependency graph while letting its tests reach a container. Note the boundary lint is a **deny-list** whose positive allow-matrix is **unimplemented** (owner: task 28) — so today the boundary is prose, and "enforced by nothing" cuts both ways.
- **(b) Keep the db-server-homing pattern** and accept that `apps/server` integration stays on a substitute forever — in which case **say so in T-8/T-14f and in every affected gate**, because a lane that cannot ever satisfy D16 must not imply it does (§2.11: a gate implying absent coverage is worse than no gate).
- **(c) Something else** — e.g. move the seam so the production path itself lives where the real lane can see it.

**The orchestrator has no preferred answer here and is not ruling it** — it is a genuine architecture decision with a spec change on one side and a permanent coverage hole on the other. Bring evidence, not a preference. If (a), the `pg`-in-apps/server question is a **§6 red flag** (a boundary/stack change) — surface it rather than deciding unilaterally.

## THE DESIGN — owner-specified, 2026-07-16 (build this; the shape is not open)

> *"let's do testcontainers and migrate once, and then create new databases based on templates (of course make sure the parallelism doesn't crash this one instance), or maybe you can launch multiple containers (e.g. cap 1 container to 50 databases, and for more launch another container, etc.)"*

**One container, migrated once, per-file databases cloned from a template — and shard to more containers when a cap is hit.** The orchestrator verified the load-bearing constraints on the real PG 16.14 rather than asserting them; the numbers below are measured.

### The mechanism

1. **Boot one `postgres:16` container** (testcontainers, `.withReuse()`), production major pinned in code.
2. **Migrate ONCE** into a template database (e.g. `bolusi_tmpl`) — the full migration chain, one time, at global setup.
3. **Per test file: `CREATE DATABASE <file_db> TEMPLATE bolusi_tmpl;`** — a filesystem-level copy, milliseconds. **No WASM boot, no re-migrate.**
4. **Re-enable `fileParallelism`** — the reason it is `false` today (a single shared DB that each file resets) disappears when each file owns a database.
5. **Shard on the cap**: when files exceed the per-container ceiling, boot another container.

### THE ONE RULE THAT MAKES OR BREAKS IT — proven, not assumed

**`CREATE DATABASE … TEMPLATE` fails while ANY session is connected to the template.** Measured on PG 16.14 by the orchestrator:

| probe | result |
| ----- | ------ |
| clone with **no** connections to the template | `CREATE DATABASE` ✅ |
| clone while **one** session holds the template | ❌ `DETAIL: There is 1 other session using the database.` |

**So: migrate the template, then never connect to it again.** Not for a health check, not for a "quick verify", not for codegen. If anything holds it open, every clone fails — **loudly**, which is the good failure. Guard it: the clone helper should `pg_terminate_backend` stragglers on the template (or assert zero `pg_stat_activity` rows for it) and **fail with the reason**, not retry blindly.

### THE CAP IS `max_connections`, NOT DATABASE COUNT — measured

The owner's "~50 databases per container" instinct maps onto a real ceiling. Measured on the running container: **`max_connections = 100`**, **`shared_buffers = 128MB`** (stock defaults).

**Databases are cheap; CONNECTIONS are the resource.** An idle cloned database costs disk and catalog rows. The thing that will crash the instance is **N parallel files × pool size** exceeding `max_connections`, and Postgres reserves `superuser_reserved_connections` (default 3) on top. So:

- **Compute the cap from connections, not from a database count**: `maxParallelFiles × poolSizePerFile + headroom ≤ max_connections`. With a pool of 1–2 per file, ~50 is a sound cap — the owner's number is right, for the right reason.
- **Raise `max_connections` deliberately if you want more per container** (`-c max_connections=200`), and **say what it costs**: each backend is a process with its own memory; 200 × `work_mem` is real. Prefer sharding to a second container over an unbounded `max_connections`.
- **Shard when the cap is hit**: container 1 takes files 1–50, container 2 takes 51–100, etc. Each container migrates its own template once. **State the sharding key** (file path hash, or a work-stealing pool) and make it deterministic so a failure is reproducible.
- **Falsify the cap**: drive parallelism past it and prove you get a **clear, attributable error** (`FATAL: sorry, too many clients already`) rather than a wedge or a silent hang. **This repo has had unexplained vitest wedges (76 bytes, 600 s, no output) with no established cause** — do not let connection exhaustion become a second one. If your failure mode under load is a hang rather than an error, the design is not done.

### Do not lose what `db-lane.mjs` already bought (task 34)

It exists because a fixed host port let a failed `db:up` **silently resolve to a peer worktree's database**, and task 13's "82/11 on real PG16" was produced by task 05's leaked container — a real number with fictional provenance. Whatever replaces it keeps: **ephemeral ports** (testcontainers' `getConnectionUri()` gives this by construction), a **fatal** failure to start, and the **`bolusi.db_owner` attribution GUC** or equivalent — asserted, not advisory. A green whose provenance is unknown is not a green (T-14d).

## Acceptance

**Observable done-condition:** the L3 lane runs on real PG16 over the real `pg` driver, an RLS test on it can actually fail, and no gate's name says "Postgres" without saying which one and over which client.

- **Doc-first** (testing-guide's own rule): update **§2's environment table**, **T-8's scope paragraph**, and **T-14f rule 3** BEFORE the code. Those three currently *document* the gap; leaving them stale would mean the specs describe a lane that no longer exists — this repo has seven recorded instances of authoritative-but-wrong prose (T-15/T-16).
- **Reproduce the value first** (T-11) — **and it has ALREADY BEEN DONE, independently, on a different bug site.** impl-17, building task 17 under D16, ran exactly this pair: the same int8 class → **PGlite 10/10 GREEN vs real PG16 1 RED**. See task 17's Outcome for the commands, file, and both `EXIT=` lines. **Confirm it yourself rather than citing this file** (T-16 — a mention is not a producer, and this task file is a mention), but the premise is not speculative: two independent measurements now agree (task 48's 14/14-green-vs-4-red, and impl-17's 10/10-green-vs-1-red). If it does *not* reproduce for you, that is a real finding — **STOP and report** (four premises have been refuted on this project; every refusal was correct).
  - **THE ALIBI — read this before choosing your probe value.** impl-17 measured it and the orchestrator verified it in Node: the int8 defect is **lexicographic ordering over differing digit counts**, NOT magnitude. `"10" > "9"` → false (bites), `"100" > "99"` → false (bites), but `"9007199254740993" > "9007199254740992"` → **true**, correct by luck (equal length ⇒ digit-by-digit). **A probe near 2^53 — the instinctive choice, and the one this task file originally implied — is GREEN with the bug fully present.** Probe a digit-count boundary (9→10, 99→100). The model "this is about bigints" selects the alibi; the accurate model is "this is about string ordering."
  - **What impl-17's result adds beyond task 48's:** task 48's measurement was on a decoder in `db-server`, where the real-PG lane can already see it. impl-17's was on **new code being written under D16**, which means the substitute would have let a *fresh* silent bug through **today**, in a task shipped after the rule was written. The gap is not historical.
- **The RLS trap — do not swap one vacuous lane for another.** Testcontainers' default user is the **DB owner**, so `postgres`-as-owner makes RLS tests pass for exactly the reason T-14b documents. The container MUST provision **`bolusi_app` (NOBYPASSRLS)** and the suite MUST connect as it. **Falsify it**: point an RLS test at a tenant it must not see, and prove it **RED** — then prove the positive control (the legitimate tenant DOES see its row, T-17: *a fence with no positive control proves only that nothing happened*).
- **Preserve attribution** (T-14d) — the lane still asserts **which database answered**, and fails loudly if it cannot tell. `getConnectionUri()` is derived from the started container, so there is no fixed port to fall back to; keep the `bolusi.db_owner` GUC check or an equivalent that is **fatal**, not advisory. A green whose provenance is unknown is not a green.
- **A leak was observed WHILE this task sat unstarted — use it.** 2026-07-16: `impl-17` finished and reported, and its container `agent-aa836efa596653d18-postgres-1` **was still running afterwards**. Nobody was careless; the agent simply ended without a teardown, which is the failure mode `db-lane.mjs`'s own header predicts and which **Ryuk exists to make impossible**. Note also that a **`testcontainers-ryuk-*` container was already running on this same box** (from an unrelated project), which answers the CI/environment question below: testcontainers demonstrably works here, Ryuk included. Both facts are evidence, not argument — cite them.
- **Ryuk is the point — verify it, don't assume it.** Kill a test process mid-run (`SIGKILL` the runner) and prove the container is reaped. This is the structural closure of the leaked-container class that produced the "82/11" fake green; if Ryuk is disabled in this environment (it can be), **say so loudly** — the task's main structural benefit would be absent and `db-lane.mjs`'s hand-rolled protections must stay.
- **This may be a large SPEEDUP, not a slowdown — measure it, do not assume either direction.** D16 accepted a slowdown as the price of fidelity. **That framing is probably wrong, and the orchestrator had the diagnosis backwards.** Measured 2026-07-16: the box is **48 cores at ~75% idle** with 40 GB free, yet **`apps/server` (50 test files) and `packages/db-server` (15) both set `fileParallelism: false`** — 65 files run strictly one at a time. `test:server` is **550–685 s for 50 files ≈ 11–13 s/file, serialized**; the other 128 files (core/mobile/ui/i18n) run in parallel and are comparatively fast.
  **And PGlite is the stated reason for the serialization**, in the configs' own words: `apps/server/vitest.config.ts` — *"Several suites boot a PGlite instance + full migrate per test … parallel files contend on CPU and time out"*; `packages/db-server/vitest.config.ts` — *"each test file owns a database … resetting the schema of ONE shared postgres database, so files must not run concurrently."*
  **So the causal chain is: PGlite boots a WASM Postgres + full migrate PER FILE → expensive → parallelism disabled → the suite takes ~10× the wall-clock the hardware requires.** A real container inverts it: boot **once**, give each file its own database via `CREATE DATABASE … TEMPLATE <pre-migrated>` (milliseconds, no WASM boot, no re-migrate), and the reason `fileParallelism: false` exists **disappears**. **Test that hypothesis — do not ship it as a claim.** Report before/after wall-clock for the L3 lane and the full suite, and say explicitly whether re-enabling `fileParallelism` is safe once each file owns a real database (db-server's serialization is load-bearing **only** because files share one DB today).
  **A caution the orchestrator earned the hard way:** it asserted "the machine is oversubscribed (load 15–20)" **three times**, including into an earlier revision of this file, and then measured: 75% idle, 2 running processes, 4 in D-state. **Load average counts uninterruptible-sleep processes and is not a utilization metric**; on 48 cores it said almost nothing. Measure `%idle`/`%wa`/`r`/`b`, not load. And note what is **still unexplained**: vitest has repeatedly **wedged at the banner** (76 bytes, no output, 600 s) — that is real, it is **not** general CPU saturation, and nobody has established its cause. Do not inherit a guess about it; if it bites you, diagnose it.
  Note `db-lane.mjs`'s recorded flake: an init checkpoint took 31 s and overran a healthcheck start period, so **set generous startup timeouts**, and note task 67 (a 5 s test timeout that reds under parallel load).
- **PGlite's residual role — decide and state it.** D16 does not mandate deletion. Either (a) keep it as a fast pre-filter where it demonstrably proves something real PG also proves, with its scope written into the gate per T-14f rule 3; or (b) remove it. **Say which and why.** What it may NOT be, after this task, is the sole witness for any claim about the driver, RLS, or a version-sensitive behaviour. If it stays, `shipping-deps.test.ts`'s `TEST_ONLY_PACKAGES` must still hold.
- **CI** (`08 §5.6`): the lane must work on a cold runner. Note §5.6's existing rule — every test script builds its deps first (task 55) — and that task 62 has filed §5.6's worked example as defective. Docker-in-CI availability is a real constraint: **verify, don't assume**, and if a CI job cannot run containers, say so rather than quietly leaving CI on the substitute (that would be a gate implying coverage it lacks — §2.11).
- **Assert the denominator** (T-14): how many tests moved to real PG, how many remain on a substitute, and **which**. "378 tests migrated" is only meaningful next to "and N did not, because X."
- `pnpm test`, `pnpm test:rls`, `pnpm lint`, `pnpm typecheck` green — **read the output, not the exit code** (§2.1). **T-18**: a "completed (exit code 0)" notification has repeatedly described a **reaped** run whose log had no `Test Files N passed` line — `wc -c` a fast log and confirm the denominator. **Scratch files in your worktree or `$CLAUDE_JOB_DIR/tmp`, never bare `/tmp/<name>.log`** (`/tmp` is shared across agent worktrees; a peer read another agent's log this session).
- **Coordinate:** `packages/db-server` and the test lanes are contended (§4). Check `_index.md` for in-flight work before starting and serialize if needed.

## Note

The owner's directive and this repo's evidence point the same way, which is worth stating plainly: **we already ran the experiment.** The fast substitute was chosen deliberately and reasonably (`testing-guide §2:87` — *"PGlite is the fast loop, real Postgres is the drift check"*), and then it let two silent bugs through — a watermark that never advanced, and an RLS lane that could not fail — while showing green. The `08` catalog row had *already* written the warning (*"do not trust WASM as the only RLS witness"*), and the warning did not save us, because a warning is not a mechanism. That is the same lesson as `db-lane.mjs`'s header, §2.1's exit codes, and §2.11's whole thesis: **the rule was already written; it did not help; the fix has to be by construction.**

Worth carrying: the reason to prefer testcontainers over the existing hand-rolled compose lane is **not** that the lane is bad — task 34's lane is careful, attributed, and correct. It is that Ryuk makes the leak *impossible* rather than *guarded against*, and a pinned image puts the production major in code where a test can read it. Choosing the mechanism over the discipline is the one move this project has consistently been right about.
