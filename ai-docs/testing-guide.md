# Testing Guide

> **Owns:** test-quality rules for every suite in the repo, the test pyramid and its environments (which DB engine and crypto provider runs where), the **chaos harness** normative spec (v0 exit criterion D4.1: fixtures, determinism, the convergence oracle, the scenario catalog with pass criteria), and the on-device performance gates. Envelope/hashing/rejection semantics live in `05-operation-log.md`; the sync wire protocol in `api/01-sync.md`; the module contract and projection-engine rules in `04-module-contract.md`; state-machine states in `03-state-machines.md`; PIN lockout machine (schedule, states, recovery) in `api/02-auth.md` §6.5; media chunk protocol in `api/03-media.md`; label-catalog mechanism in `07-i18n.md`.
> **Change control:** change this doc first, then the code. A test that contradicts this doc is wrong even if it is green.

---

## 1. Part A — Test-quality rules (apply to every suite)

| # | Rule |
| - | ---- |
| **T-1** | **Test public behavior only.** The public surfaces are: command execution (`execute(command, input, ctx)` → ops/result/`DomainError`), queries (input → `{rows, nextCursor}`), the sync wire protocol (requests/responses/rejection codes per `api/01-sync` and `05 §8`), state-machine transitions on bookkeeping (`syncStatus`, `uploadStatus`, per `03-state-machines`), and label **keys**/testIDs/accessibility roles in the UI. Tests must never: import an applier directly (appliers are exercised only through the projection engine and the applier conformance suite §2.4), spy on internal functions, assert call counts of internals, or read projection tables except through queries or the harness oracle (§3.4). |
| **T-2** | **One behavior per test.** Each test asserts exactly one behavior and its name states it (`rejects push with CHAIN_BROKEN when previousHash mismatches`). A test needing "and" in its name is two tests. |
| **T-3** | **Unique values per case.** No shared magic constants (`TEST_TENANT_ID`, `NOTE_1`) reused across test cases — shared constants make tests pass by coincidence and fail in bulk. Every case builds its own values from a seeded fixture factory (`makeFixture(seed)`, §3.3); two tests shall never assert on the same literal id, title, or timestamp. |
| **T-4** | **Never assert UI copy.** Labels change via the label catalog (`07-i18n`) without touching tests. Assert label **keys**, `testID`s, and accessibility roles — never rendered strings. The i18n lint rule (no hardcoded user-facing strings) is owned by `07-i18n`; tests asserting copy are a violation of that rule by proxy. |
| **T-5** | **No snapshot tests of component trees.** `toMatchSnapshot()` on rendered trees is forbidden — it asserts everything, therefore nothing. The ONLY permitted golden files are **wire-format vectors**: JCS canonical bytes, SHA-256/Ed25519 test vectors, envelope JSON fixtures. These are hand-reviewed spec artifacts, updated only via a change to the owning spec doc. |
| **T-6** | **Determinism.** No test reads the real clock, real RNG, real network, or real timers. `04 §5.2` deliberately gives handlers **no clock** — the runtime stamps `timestamp`; therefore the runtime (client and server) shall accept an injected `Clock` at construction (`{ now(): number }`), production default = system clock, tests = `FakeClock` (§3.3). Ids: `ctx.newId()` delegates to an injected `IdSource`; the test `IdSource` builds valid UUIDv7 from `FakeClock` ms + seeded-PRNG random bits, so ids (and canonical ordering) are stable per seed. Retry/backoff logic runs on fake timers. A test that sleeps is a bug. Every randomized test prints its seed on failure and is reproducible from that seed alone. |
| **T-7** | **Production code under test.** Fakes exist only at I/O boundaries: `fetch`, clock, RNG/id source, filesystem, keystore, camera. Never mock or reimplement `@bolusi/core` logic (canonicalization, hashing, chaining, sync loop, projection engine) inside a test — the harness in particular drives the real sync engine against the real server handler (§3.1). |
| **T-8** | **Both-engine rule for appliers.** `04 §2` requires appliers to be dialect-neutral. Every module's appliers run through the shared applier conformance suite against BOTH engines (SQLite via the shim, Postgres via PGlite — §2.4) with oracle-equal output (§3.4). A module without this suite passing does not merge. |
| **T-9** | **Security surfaces ship adversarial tests before review** (CLAUDE.md §2.5). The harness scenarios CHAOS-05 (tamper), CHAOS-10 (gzip), CHAOS-11 (PIN), CHAOS-12 (pull injection) are the floor, not the ceiling — new security surface = new adversarial cases in the same style. |
| **T-10** | **A flaky test is a P1 bug.** No quarantine directory, no auto-retry-until-green. Fix the nondeterminism or delete the test with a written cause in the commit subject. |
| **T-11** | **A guard is only load-bearing if someone has watched it go red.** Every gate, guard, sweep, probe, and adversarial test SHALL be **falsified before it is believed**: break the thing it protects, observe the specific failure, restore, observe green. State the falsification in the PR/report — "I broke X, saw Y fail, reverted" — not "the test passes". This is not ceremony; v0 has already shipped **seven** gates that were green for the wrong reason: SEC-META-01 matched file *content* not test titles; the codegen-diff gate was made permanently unsatisfiable by prettier reformatting its own input; the boundary rule's platform-free prong exempted the Hermes-bound files it existed to protect; `badOwners` matched a *mention* of a SEC id, so a task **disclaiming** an id satisfied it; a codegen sweep looped over a regex parse that, if the generated format changed, would check **zero** properties and report green; the i18n key-grammar gate read *catalogs* while the parking mechanism kept parked keys **out** of catalogs, so it was green **because** the violations were invisible to it (and the same blindness exempted every module-owned row — real denominator 113 of 127); and a `test:rls` green was served by another worktree's database after an unread `db:up` failure (T-14d). Each was found only by running the mechanism. **Two of these deserve special notice: the parking case and the CI-placeholder case are guards that were green *because of* the very mechanism meant to defer or stand in for the work** — so "deferred" and "done" became indistinguishable to the checker. When you add a skip/park/placeholder path, ask immediately: does the checker still see what I just set aside? |
| **T-12** | **Test the class, not the instances you thought of.** When a bug is found, ask what *class* it belongs to and enumerate that class programmatically. `AA=A` (padding position) and `zh==` (non-canonical padding **bits**) are the same validator's problem but different classes — a fix for one collapses none of the other's 16 variants. A test suite built from remembered examples can only catch remembered examples. |
| **T-13** | **Interrogate the oracle.** A test is only as good as its reference for "correct". Node's `Buffer.from(s,'base64')` accepts `AA=A`, `A A=`, `AA%3D`, `≡A==`, and `=` — so a base64 validator tested against it **cannot fail**. Before trusting a comparison, ask what decides truth in it, and whether that thing is stricter than the code under test. Golden vectors are extracted programmatically from their source spec, never hand-transcribed (a hand-typed vector has already been wrong here: `25` vs `5c`). |
| **T-14b** | **An empty result and a correct result look identical — assert the fixture before believing the absence.** Any test whose pass condition is *nothing came back* (`0 rows`, `UPDATE 0`, no findings, empty diff) SHALL first assert the thing it expects to be filtered out actually **exists**. Real incident: this environment's docker daemon is shared; a parallel process reset the schema mid-probe (DROP SCHEMA + re-migrate leaves tables and policies but **zero rows**), and the RLS probes returned `UPDATE 0` / `0 rows` — *which reads as flawless tenant isolation and was completely vacuous*. Caught only by an inline fixture assertion. A local `pnpm test:rls` green here means nothing without it (CI is unaffected — isolated service container). This is T-14 in the data plane rather than the parse plane. |
| **T-14c** | **A stale build is a fake green — test the code you think you're testing.** When a package's unit tests import its **built** artifact (`dist/`) while another lane imports **source** (`src/`), a local run without a preceding build tests stale code and passes against yesterday's bug. This already happened here: `@bolusi/core`'s jcs-guards tests import `dist/index.js`, the Hermes vector runner imports `src/crypto/jcs.js`; a `pnpm test` with no `tsc -b` produced a green mutant run that detected nothing, and nearly fooled a reviewer who rebuilt before believing the numbers. Two lanes importing different artifacts can silently test different code. Guard it: make `test` depend on `build`, or make both lanes import the same entry, or assert build-freshness (dist mtime ≥ src mtime) in a setup step. CI that runs `tsc -b` before the test stage is protected; a bare local `pnpm test` is not. |
| **T-14d** | **Know which database answered — an unattributable green is not a green.** The dev `docker-compose.yml` published a **fixed** host port (`127.0.0.1:5432:5432`) and `test:rls` targeted a **hardcoded** `localhost:5432`, so on this shared daemon only the FIRST worktree to `db:up` bound the port. Every later worktree's `db:up` failed (`Bind for 127.0.0.1:5432 failed: port is already allocated`, EXIT=1) and its DB tests then **silently connected to another worktree's database**, applied their migrations there, and went green. Real incident: task 13's gate verification reported "82/11 on real PG16" — from **task 05's leaked container**, because `db:up` was run as `>/dev/null 2>&1` and its EXIT=1 was never read. The result happened to be real (right engine, right migrations) which is exactly what makes it dangerous: the number was correct and the reasoning behind it was fiction. Two worktrees running DB tests concurrently share one database and corrupt each other's fixtures — surfacing as flakiness (T-10), not as misconfiguration. This is the second incident from this shared daemon (see T-14b) and the first fake-green produced by the orchestrator rather than caught by it. CI was unaffected (isolated service containers) — which meant **local and CI disagreed about whether isolation exists**, and only local lied. **Closed by task 34, by construction rather than by discipline** — note that the "never redirect `db:up`" rule this row used to end with was a *discipline* fix for a defect that §2.1 had already failed to prevent once, which is why it was replaced by mechanism: the host port is now **ephemeral and per-worktree** (never re-pin `ports:` to 5432); `DATABASE_URL` is derived from `docker compose port` by `scripts/db-lane.mjs`, which makes a failed `db:up` **fatal to the lane** so no DB test can follow one; and every dev cluster is **stamped at init** with the compose project that owns it (`bolusi.db_owner`), which `packages/db-server/test/global-setup.ts` verifies before any test runs — aborting on a foreign *or absent* stamp. What survives as a rule: **believe a DB number only if its run printed the `attribution OK` provenance line**, and never `docker compose down` a container that is not yours (`pnpm db:down` only ever removes your own). |
| **T-14e** | **A number measured in a worktree is a number *about that worktree* — evidence has a scope and a timestamp, and quoting it elsewhere strips both.** A branch measures its suite honestly, someone else's work merges underneath it, and the number is now false everywhere it was quoted — while still being exactly what the author observed. **The author cannot catch this**: they measured correctly, in a tree that by definition predates the merge. Only a reader at merge time can. Real incident: task 32 recorded "stage 8 = 22 files / 162 tests" in `08-stack-and-repo.md` §7 as evidence; task 13's identity suites merged first, and main was **33 files / 199 tests** by the time the record landed — true when measured, stale when quoted, quoted in a *spec*. Same class as the leaked-container green (T-14d): a number whose provenance does not match where it is cited — but far more benign, because it was honest at the instant of measurement. **This failure mode scales with parallelism**: the more agents in flight, the more likely main has moved under any given branch's evidence. Rules: (1) a number that lands in a **durable doc** (spec, §7 record, acceptance criterion) is **re-measured against the merged result**, not copied from the branch; (2) if you cannot re-measure, cite the scope — "22/162 *as of merge-base `abc123`*" — so a reader can tell a stale number from a wrong one; (3) reviewers: check quoted numbers against main, not against the branch that quoted them. |
| **T-14** | **A coverage check must assert its own denominator.** Any sweep, enumeration, or parse-driven assertion SHALL name and check the total it expects to cover: an aggregate item count (floor set below today's real number so growth never trips it, but a starved parse fails loudly), non-zero units per parsed group, the exact set where the set is fixed. A loop over an empty or truncated collection passes silently — the failure mode of a guard must never be "verified nothing (or a fraction), reported green". Three separate instances this session were *green about the wrong question* — a codegen sweep that checked 19 of 164 properties under partial parse degradation; a `relkind='r'` RLS sweep that omitted views entirely; an SEC-id gate that matched a mention. Each was caught only by making the guard state its expected total and watching it go red when starved. |

Money in any fixture or assertion is **integer IDR** — a float literal in a payload fixture must fail the same lint that guards production code (`05 §3`).

---

## 2. Test pyramid and environments

### 2.1 The layers

| Layer | What it proves | DB | Crypto | Where it runs | Runner |
| ----- | -------------- | -- | ------ | ------------- | ------ |
| **L1 unit** | Pure core logic: JCS canonicalization, hashing, chain construction, canonical-order comparator, command handlers with stub `ctx` | none | `@noble/curves` 2.2.0 + `@noble/hashes` 2.2.0 | Node CI, every PR | vitest |
| **L2 client integration** | Command runtime + projection engine end-to-end (append → project → query) against real SQLite | better-sqlite3 `:memory:` behind the `kysely-generic-sqlite` 2.0.0 shim (§2.3) | `@noble` | Node CI, every PR | vitest |
| **L3 server integration** | Push/pull validation pipeline, RLS tenancy, migrations | PGlite via Kysely's in-core PGlite dialect (kysely 0.29.3); real PostgreSQL job for migrations + RLS (§2.5) | `@noble` | Node CI, every PR | vitest |
| **L4 protocol** | Client sync engine ↔ server over in-process HTTP: the real `@bolusi/core` sync loop calling the real Hono handler via `app.fetch` — no sockets, no ports | L2 client DB + L3 server DB in one process | `@noble` | Node CI, every PR | vitest |
| **L5 chaos harness** | §3 — multi-device convergence, faults, adversarial input | as L4, one client DB per virtual device | `@noble` | Node CI: fixed seeds every PR; nightly: extended seeds + larger volumes | vitest |
| **L6 on-device** | Same integration + core chaos scenarios + ALL performance gates on real hardware | `@op-engineering/op-sqlite` 17.1.2, SQLCipher ON (production parity), same shim dialect | `react-native-quick-crypto` 1.1.6 | Physical 2GB Android reference device, EAS build (§2.6) | in-app harness runner |
| **L7 Hermes vectors** | RFC 8785 + hash/signature vectors execute correctly on Hermes (JCS number serialization depends on spec-correct ES number→string; Hermes must be proven, not assumed) | none | `canonicalize` 3.0.0 + `@noble` | CI: Metro-bundled vector runner executed by the Hermes VM binary; re-run redundantly inside L6 | hermes CLI |

vitest is the Node-side runner; its exact version is pinned in the lockfile at implementation time (it was not covered by the stack-research pass — do not treat any vitest version cited elsewhere as spec).

### 2.2 Crypto interop suite (runs in L1 and L6)

`@noble` (server/CI) and `react-native-quick-crypto` (device) must be RFC 8032-interoperable. A shared golden vector file (`@bolusi/test-support/vectors/ed25519.json`) contains: known 32-byte seeds → expected public keys, known messages → expected signatures (Ed25519 is deterministic, so signatures are byte-comparable). L1 asserts `@noble` reproduces every vector; L6 asserts quick-crypto reproduces every vector AND cross-verifies (`@noble`-produced signatures verify under quick-crypto and vice versa via the vector file). The same file carries SHA-256 vectors and the RFC 8785 test vectors (Appendix of the RFC) used by L7. Adding a vector requires a change to `05-operation-log.md` or this doc first.

### 2.3 Client DB engine decision (normative)

op-sqlite is a JSI native module and **cannot run in Node** — CI needs a different driver, but the Kysely dialect layer must be identical or CI proves nothing about the device.

- There is exactly **one** client dialect implementation: a custom shim built on `kysely-generic-sqlite` 2.0.0 (no official op-sqlite Kysely dialect exists), with **two driver adapters** behind one driver interface: `better-sqlite3` (in-memory) for Node/CI, `@op-engineering/op-sqlite` 17.1.2 for device. better-sqlite3's exact version is pinned in the lockfile at implementation time (not version-verified by research).
- A **driver conformance suite** in `@bolusi/test-support` runs the identical statement set (types round-trip, transaction commit/rollback, prepared-statement reuse, batch insert, error mapping) against both adapters — better-sqlite3 in CI, op-sqlite in L6 — and asserts identical results. This is what licenses "green in CI ⇒ meaningful on device".
- The op-sqlite single-connection rule (one open connection per database, app-wide) is mirrored in the harness: each virtual device owns exactly one connection to its own DB.
- SQLCipher is OFF in CI (better-sqlite3 has none; encryption-at-rest is not what L2–L5 prove) and ON in L6.

### 2.4 Applier conformance suite (T-8 mechanism)

For every module: take a fixed seeded op script (§3.3), fold it through the projection engine once against the SQLite shim and once against PGlite, dump both via the oracle (§3.4), assert byte-equal digests. This is the "shared test suite that runs every applier against both engines" required by `04 §2`. It runs in L2+L3 on every PR touching the module.

### 2.5 Server tenancy tests (RLS)

PGlite is real Postgres, but connections run as the superuser/table owner, and **owners bypass RLS by default** — a naive RLS test on PGlite passes vacuously. Therefore, normative:

1. Migrations create a dedicated non-superuser, non-owner role (`app_user`, `NOBYPASSRLS`) and production connects as it; RLS tests execute `SET ROLE app_user` inside the test transaction before any tenant-table access.
2. A catalog assertion runs in CI: every table carrying a `tenant_id` column has `pg_class.relrowsecurity = true` and at least one policy — a new tenant table without RLS fails the build.
3. Adversarial cases (mandatory): query without `set_config('app.tenant_id', …, true)` returns zero rows / fails closed; a `forTenant(A)` handle can never read tenant B rows even when the WHERE clause is deliberately omitted at the repository layer (proving RLS is the backstop, not the filter); `set_config` with `is_local = true` does not leak across two sequential transactions on the same pooled connection.
4. The migration + RLS subset of L3 also runs against **real PostgreSQL** (Docker, production-pinned major) in the pre-merge pipeline — PGlite is the fast loop, real Postgres is the drift check.

### 2.6 On-device suite (L6) design

- A hidden **Harness screen** in the reference app, compiled in only when `BOLUSI_TEST_HARNESS=1` (EAS build profile `test`, defined in `08-stack-and-repo.md` §5.5; the flag never exists in production profiles). Expo Go cannot run this stack (SQLCipher, quick-crypto, push) — EAS development/test builds are mandatory.
- The screen runs: driver conformance (§2.3), the L2 integration set, crypto interop (§2.2), L7 vectors, chaos scenarios CHAOS-01/03/06/07 with reduced volumes, and all Part C performance gates. Results emit as one JSON document to logcat (`BOLUSI_HARNESS_RESULT` tag) and on-screen; a repo script (`pnpm harness:device`) drives it via `adb` and fails non-zero on any red.
- On-device protocol/chaos scenarios point at a harness server (laptop, same Wi-Fi) via config; performance gates that are network-bound state their network assumption (§4).
- **Performance gates run on a release-variant build** (Hermes bytecode, JS dev mode off) of the `test` profile — dev-mode numbers are meaningless.
- The reference device is a designated physical 2GB-RAM / 32GB-storage Android unit (documented in the repo README when purchased); gates are defined against that exact device. Emulators satisfy nothing in Part C.

---

## 3. Part B — The chaos harness (normative spec)

The harness is monorepo package `@bolusi/harness` (workspace layout and import boundaries per `08-stack-and-repo.md` §3). It depends only on public packages (`@bolusi/core`, `@bolusi/server`, the `notes` module manifest) plus `@bolusi/test-support` fakes (also a workspace package per `08` §3). It contains **no protocol logic of its own** (T-7) — with one exception: a **raw wire client** used exclusively by tamper scenarios to POST hand-built `SignedOperation` JSON that production code refuses to construct.

### 3.1 Fixture architecture

```
Harness(seed, config) = {
  server:  { app: Hono fetch handler (production @bolusi/server),
             db: PGlite, clock: FakeClock (server), seeded tenant/store/users/devices },
  devices: VirtualDevice × N (default N = 4),
}

VirtualDevice = {
  identity:  deviceId, storeId, userId set, Ed25519 keypair
             (privateKey seed = SHA-256(harnessSeed ‖ deviceIndex) — deterministic),
  db:        own SQLite via the shim (§2.3) — better-sqlite3 :memory: in CI, op-sqlite file on device,
  runtime:   production command runtime + projection engine + sync engine,
  clock:     own FakeClock — independently settable/skewable per device,
  net:       FaultFetch(server.app.fetch) — fault-injecting fetch wrapper (§3.5),
}
```

Devices are pre-enrolled in the server fixture (pubkeys registered, device tokens issued) unless a scenario says otherwise. Each virtual device holds its own chain state (`seq`, `previousHash`) purely as a consequence of running the production append path.

### 3.2 Reference module requirements

The `notes` module (`04 §8`) is the harness workload. Two testability requirements on its projection (additive to the `04 §8` checklist):

1. The `notes` projection table shall include `edit_count` (integer, incremented by each `notes.note_body_edited` apply) — declared as a testability column in `01-domain-model` §9 and in both notes DDLs in `10-db-schema`. A last-write-wins-only projection cannot reveal double-application; `edit_count` makes any idempotency violation visible to the oracle.
2. The op script generator must exercise the `schemaVersion: 2` migration seam: v1 payloads before a seeded cutover index, v2 after (per `04 §3`).

### 3.3 Determinism kit (`@bolusi/test-support`)

| Component | Spec |
| --------- | ---- |
| PRNG | **mulberry32** (pinned algorithm — cross-platform reproducible from a uint32 seed). All harness randomness flows from it. |
| FakeClock | `{ now(): number, advance(ms), set(ms) }` — injected into runtimes per T-6. One per device + one for the server. |
| IdSource | UUIDv7 from FakeClock ms + PRNG random bits (T-6). |
| Keypairs | Derived from seed (§3.1) via `@noble/curves` in CI, quick-crypto on device — identical keys per seed by RFC 8032 determinism. |
| Op script generator | `generateScript(prng, {opsPerDevice, deviceCount, cutoverIndex})` → deterministic sequence of command invocations per device. Mix: 20% `createNote`, 60% `editNoteBody` (target = PRNG-chosen existing entity, biased 30% toward the 5 most recent — forces same-entity contention), 15% `archiveNote`, 5% media-attach command. Timestamps advance each device's FakeClock by PRNG-chosen 1–600 s per op. |
| Seeds in CI | Every PR: fixed seeds **1–10** per scenario. Nightly: 100 PRNG-chosen seeds per scenario, each logged; a nightly failure is reproduced locally by seed. |

### 3.4 The convergence oracle (defined once; every convergence assertion uses it)

`digest(db, module)` — engine-neutral, byte-exact:

1. Tables = the module's projection tables per its manifest, ascending byte order of table name. **Excluded:** the op log, watermark tables (`applied_server_seq`/`applied_local_seq`), all client bookkeeping (`syncStatus`, `syncedAt`, …), `SyncState`, `quarantined_ops`.
2. For each table, `SELECT` the manifest-declared columns in declaration order — all rows, **no SQL ORDER BY** (collation differs across engines; sorting happens in JS).
3. Normalize each scalar:

   | Stored value | Normalized |
   | ------------ | ---------- |
   | NULL | `null` |
   | integer (incl. pg `int8` returned as string) | JSON integer; if magnitude > 2^53 − 1 → decimal string |
   | boolean-declared column (pg `true/false`, SQLite `0/1`) | `1` / `0` |
   | text | JSON string |
   | blob / `bytea` | `"0x"` + lowercase hex |
   | any float / non-integer numeric | **oracle ERROR** — floats are banned from projections (`05 §3`); the oracle enforces it |

4. Each row → `JCS([tableName, v1, …, vn])` (RFC 8785 via the same shared implementation ops use, `05 §3`).
5. Sort all row-lines of the whole module ascending by UTF-8 byte order; `digest = SHA-256( join(lines, "\n") + "\n" )`.

**Convergence** = digests byte-equal. The **canonical-fold reference** for an op set: fresh DB via the shim, insert nothing, feed all ops to the production projection engine strictly in canonical order `(timestamp ASC, deviceId ASC, seq ASC)` (`05 §4`), then `digest()`. Every convergence scenario asserts: each device's digest == every other device's == the server's == the canonical-fold reference.

### 3.5 Fault-injection points (used by CHAOS-02/09)

`FaultFetch` injects, per scheduled (requestIndex, point):

| Point | Meaning |
| ----- | ------- |
| **F1** | Request never reaches the server (network error before send). |
| **F2** | Server processes the request fully; response lost. |
| **F3** | Response received; client process "crashes" before persisting the outcome (per-op statuses / cursor). Simulated by discarding in-memory state and re-opening the device DB. |
| **F4** | Pull only: local apply-transaction commits; crash before cursor persists (`api/01 §4` — cursor is written after the atomic apply). |
| **F5** | Pull only: crash mid apply-transaction (transaction rolls back). |

"Every batch boundary" means: for a backlog forming **B** push batches and **C** pull batches, the scenario runs once per (boundary k ∈ [0, B+C], applicable fault point) pair.

### 3.6 Scenario catalog

Every scenario: takes a seed; asserts with unique per-seed values (T-3); prints the seed on failure. PASS criteria are exhaustive — anything beyond them observed as a diff (extra ops on server, extra rows in dumps) is a failure.

---

**CHAOS-01 — Out-of-order arrival (projection convergence, FR-1118 / 04 §4.2)**
- *Setup:* 3 devices, script of 500 ops each incl. same-entity contention; all offline (no sync during generation).
- *Action:* Deliver every device's ops to every other device and the server in PRNG-shuffled arrival order (via sync where possible; direct engine feed for arrival-order permutations the protocol itself cannot produce). Must hit both `04 §4.2` paths: ops that arrive canonically-newest for their entity (head case) and ops that sort before an already-applied op (re-fold case) — the harness asserts both counters > 0 via the engine's public stats, or fails as inconclusive.
- *PASS:* All device digests == server digest == canonical-fold reference.

**CHAOS-02 — Interrupted sync at every batch boundary (FR-1122)**
- *Setup:* 1 device with 1,600 local ops (4 push batches of ≤ 500 per `api/01 §3`); server holding 1,600 foreign ops (4 pull batches).
- *Action:* For every (boundary, fault point F1–F5) pair per §3.5: run the sync loop, inject, then let the loop resume (fake-timer backoff per `api/01 §6`).
- *PASS:* After resume completes: server op count == exactly 1,600 pushed ops (no loss, no dupes — F2 retries must come back `duplicate`, never re-insert); every pushed op `syncStatus = synced`; device digest == canonical-fold of all 3,200 ops; pull cursor == final `serverSeq`; no batch was skipped (F4 re-pull was an idempotent no-op, F5 re-pull re-applied).

**CHAOS-03 — Days-offline bulk merge (FR-1123)**
- *Setup:* 4 devices offline 7 simulated days, ~500 ops/day each via FakeClock advancement (≈ 3,500 ops/device).
- *Action:* Reconnect devices one at a time, full sync each.
- *PASS:* Convergence (all digests == canonical fold of all ~14,000 ops); pull was incremental — each device's pull transferred only ops it lacked (assert transferred-op counts, no re-download of the world); push batching respected ≤ 500 ops per batch.

**CHAOS-04 — Clock skew (05 §6)**
- *Setup:* Device A clock +72 h, device B clock −72 h, both `lastSyncAt` < 1 h ago (so threshold ≈ 48 h); device C offline 5 simulated days with +72 h skew (threshold ≈ 48 h + 120 h — within allowance); device D honest.
- *Action:* All generate ops, all sync.
- *PASS:* A's and B's ops: accepted with `clockSkewFlagged = true` — **never rejected** (`05 §6`: assume drift, not malice); C's ops: accepted, `clockSkewFlagged = false`; D unflagged. Flagged ops appear in projections like any other. Convergence holds — canonical order uses `timestamp` as written, so ordering stays deterministic even with A's ops sorting "in the future".

**CHAOS-05 — Tampered chain / rejection matrix (05 §8, api/01 §3)**
- *Setup:* Enrolled device with a valid 20-op chain, pushed. Tamper cases are built with the raw wire client (§3 preamble).
- *Action / PASS (exact codes, exact `results[].status`):*

  | Case | Mutation | Expected |
  | ---- | -------- | -------- |
  | T1 | Payload field modified; `hash`/`signature` untouched | `rejected` / `BAD_SIGNATURE` (server recomputes the JCS hash; signature fails against it) |
  | T2 | Payload modified and re-signed with a non-enrolled key | `rejected` / `BAD_SIGNATURE` |
  | T3 | `previousHash` set to a wrong value | `rejected` / `CHAIN_BROKEN`; every later op in the same batch `rejected` / `CHAIN_HALTED` (`api/01 §3`); client halts push and surfaces |
  | T4 | Two ops' `seq` values swapped (reorder) | first out-of-order op `rejected` / `CHAIN_BROKEN` |
  | T5 | `seq` skips ahead (gap) | `CHAIN_GAP`; client re-pushes from the gap; all ops eventually `accepted` — not an error state |
  | T6 | `tenantId` of another tenant, correctly signed | `rejected` / `SCOPE_VIOLATION` (`05 §9`, fail closed) |
  | T7 | Push from a revoked device (Device.status `revoked` — terminal, `03-state-machines`) | HTTP 401 + ops `rejected` / `DEVICE_REVOKED` (`api/01 §2`) |
  | T8 | Correctly signed op whose payload violates the registry Zod schema | `rejected` / `SCHEMA_INVALID` |
  | T9 | Correctly signed op with a `type` absent from the server registry | `rejected` / `UNKNOWN_TYPE` |

- *PASS (all cases):* rejected ops are **absent** from the server log and never appear in any other device's pull; on the client each stays in the local log with `syncStatus = rejected` (terminal), `rejectionCode` set, surfaced — never deleted, never silent (`05 §8`); untampered devices still converge.

**CHAOS-06 — Duplicate replay / backup-restore (05 §5)**
- *Setup:* Device A with 300 synced ops; server converged.
- *Action:* (a) Re-push A's last 2 batches verbatim (simulated lost-ack retry). (b) Clone A's DB file to device A′ (same keys, same chain — a backup restore), reset A′'s in-memory state, run its sync loop. (c) Feed a pull batch containing 50 ops A already holds.
- *PASS:* (a)+(b): every replayed op returns `duplicate`; server op count and each op's original `serverSeq` unchanged. (c): pull-applying an op whose `id` exists locally is a no-op. All digests unchanged — in particular every `edit_count` value (§3.2) identical before/after, proving no projection double-application.

**CHAOS-07 — Concurrent same-entity edits, 2+ devices (04 §8; conflict classification per 01 §8)**
- *Setup:* Devices A, B, C share one synced note. All go offline; each edits the same note's body with a distinct seed-derived value. Sub-case (i): distinct timestamps. Sub-case (ii): **identical `timestamp`** on A and B (tie forced via FakeClock). Sub-case (iii): a second synced note — device A archives it while device B, offline, edits its body (edit-after-archive).
- *Action:* Sync all in PRNG-chosen order. In sub-case (iii), after the conflict surfaces, an owner device acknowledges it (appending `platform.conflict_acknowledged`) and syncs.
- *PASS:* Convergence everywhere. Winning body = the canonically **last** op's payload under `(timestamp ASC, deviceId ASC, seq ASC)` — asserted against the explicitly computed winner; in the tie sub-case the op from the greater `deviceId` (byte order) wins, deterministically, on every device and the server. `edit_count` = total edits from all devices (no edit lost even when overwritten). Conflict classification per `01 §8`: sub-cases (i) and (ii) each produce a Conflict record `{key: 'note.body', severity: 'minor'}` that walks `detected → auto_resolved` (LWW outcome stands; the record stays queryable, never surfaced); sub-case (iii) trips the Rule-2 invariant check `notes:edit_after_archive` at server fold → Conflict `severity: 'significant'`, `detected → surfaced`, then `surfaced → acknowledged` on every device once the acknowledgment op syncs. Both Conflict resting transitions (`auto_resolved`; `surfaced → acknowledged`) are thereby exercised (D4).

**CHAOS-08 — Projection rebuild mid-stream (04 §4.3, FR-1116)**
- *Setup:* Device with 20,000-op history; a control device holding the identical op set that never rebuilds.
- *Action:* (a) Start full rebuild; kill the process (state discard + DB reopen) at 25/50/75% of the watermark; resume — rebuild must continue from the watermark, not restart. (b) Start full rebuild while 500 new ops arrive interleaved via pull and local commands.
- *PASS:* Post-rebuild digest == control device's incremental digest == canonical fold including the mid-stream ops. Rebuild resumability proven by watermark monotonicity (never re-applies below the watermark after resume).

**CHAOS-09 — Media upload interruption at every chunk boundary (api/03-media)**
- *Setup:* MediaItem of `4 × chunkSize + 3` bytes (uneven final chunk; `chunkSize` per `api/03-media`), PRNG-filled content, client-side SHA-256 recorded at capture.
- *Action:* For every chunk boundary k and fault points F1–F3: interrupt, then let the foreground drain loop resume. Plus one mid-chunk truncation case (partial chunk body).
- *PASS:* Upload completes; server-assembled bytes' SHA-256 == the client's recorded SHA-256; server never stores a chunk twice (received-chunk tracking); truncated chunk is rejected and re-sent cleanly; `uploadStatus` walks only `pending → uploading → (failed → uploading)* → uploaded` (`03-state-machines`; `uploaded` terminal); the op referencing the media synced independently of media completion (`api/01 §8`).

**CHAOS-10 — gzip bomb + malformed gzip on push (stack: bearerAuth → bodyLimit → decompression cap → zValidator)**
- *Setup:* Server with production middleware chain; caps at their production values.
- *Action / PASS:*
  | Case | Input | Expected |
  | ---- | ----- | -------- |
  | G1 | Wire bytes ≤ `bodyLimit`, decompressed size > decompressed cap (gzip bomb) | rejected `413`; decompression aborts at the cap (bounded memory — assert the stream was not fully expanded) |
  | G2 | Truncated gzip stream | rejected `400` |
  | G3 | `Content-Encoding: gzip` with non-gzip bytes | rejected `400` |
  | G4 | Wire bytes > `bodyLimit` | rejected `413` before decompression runs |
  | G5 | Valid gzip within both caps | `200`, ops processed normally |
- *PASS (all):* zero ops persisted from G1–G4; the immediately following valid push (G5 re-run) succeeds — the server survives.

**CHAOS-11 — PIN rate-limit escalation timing (FR-1011; lockout machine owned by api/02-auth §6.5)**
- *Setup:* Enrolled user with a known PIN; auth module with FakeClock; the escalation schedule (attempts 1–3 free; consecutive-failure delays 30 s / 60 s / 120 s / 300 s cap; hard lockout at the 10th failure) imported as the auth package's exported constants — this scenario must not duplicate the numbers as literals.
- *Action:* Repeated wrong-PIN attempts, advancing FakeClock precisely around each configured delay; then the two recovery paths.
- *PASS:* Delays match the schedule exactly under FakeClock: an attempt at `delay − 1 ms` throws `PIN_RATE_LIMITED`, at `delay` is accepted for evaluation. During a delay window or lockout, attempts (wrong **or correct** PIN) are refused **without executing argon2id** (KDF-invocation spy count unchanged — no battery/timing oracle): `PIN_RATE_LIMITED` while `delayed`, `PIN_LOCKED` while `locked_out`. The 10th consecutive failure enters `locked_out` and emits `auth.pin_locked_out`; a successful PIN before that resets the counter to 0. Recovery is **offline-only** (`api/02-auth` §6.5 — there is no online self-recovery path to assert): owner unlock via `auth.clearPinLockout` (permission `auth.pin_unlock`) and owner PIN reset via `auth.resetPin` each clear the lockout under FakeClock with zero network calls (FaultFetch asserts none). Lockout state survives a simulated restart (state discard + DB reopen) via `pin_attempt_state`, and a FakeClock rollback never shortens a `notBefore` window. Attempt/lockout observability per `api/02-auth` §6.5: per-attempt records in local state, `auth.pin_locked_out`/`auth.pin_lockout_cleared` ops as the tenant-synced evidence (FR-1045 analog for auth events).

**CHAOS-12 — Pull-side injection (api/01 §4.2: trust, but verify)**
- *Setup:* Harness server variant that injects into a pull response one op with a bad signature and one op signed by a key not in the device's `device_registry`.
- *Action:* Device runs its pull loop. Later, the harness server adds the unknown key to the devices sidecar (bumping `devicesDirectoryVersion`) and the device pulls again.
- *PASS:* Per `api/01 §4.2`: the bad-signature op is quarantined immediately; the unknown-pubkey op triggers exactly **one** re-pull with `devicesDirectoryVersion: 0` (fresh sidecar) and — still unknown — is then quarantined. Quarantine is asserted on the client `quarantined_ops` table: both ops present there, absent from projections and the applied set; the pull cursor **advances past both** (one bad op never bricks sync); the failure is surfaced loudly (label key `sync.quarantine.*`, asserted per T-4). Subsequent valid pulls still work. When the later sidecar update delivers the missing pubkey, the quarantined unknown-key op is re-verified, applied via the engine's out-of-order path, and leaves `quarantined_ops`; the bad-signature op stays quarantined. Unverifiable history never enters projections silently, and untampered devices still converge.

### 3.7 CI wiring and v0 exit mapping (D4.1)

| Decision D4 clause | Scenario(s) |
| ------------------ | ----------- |
| multi-device sync simulation | fixture §3.1 (all scenarios) |
| out-of-order arrival | CHAOS-01 |
| clock skew | CHAOS-04 |
| interrupted/resumed sync | CHAOS-02, CHAOS-09 |
| tampered chains rejected | CHAOS-05, CHAOS-12 |
| days-offline merge | CHAOS-03 |
| idempotent replay | CHAOS-06 |
| projection rebuild against realistic history volume | CHAOS-08 (Node) + P-2 (device, §4) |

Every PR: seeds 1–10, CI-scale volumes (as written above). Nightly: 100 random seeds, volumes ×4, plus the real-Postgres L3 job. v0 exit additionally requires the L6 on-device run green (§2.6) — CHAOS-01/03/06/07 at reduced volume plus all of Part C, on the physical reference device.

---

## 4. Part C — Performance gates (physical 2GB device, release-variant build)

### 4.1 The seed: `SEED-200K` (year-equivalent history)

**200,000 operations**, generated deterministically (seed 42) via the §3.3 generator scaled to ~20,000 entities × ~10 ops each, plus 5,000 MediaItem metadata rows, v1→v2 schema cutover at op 100,000.

*Justification:* one busy store's daily op volume, estimated from the v1 module PRDs — POS ~60 sales × 2 ops = 120; repairs ~12 × 8 lifecycle ops = 96; inventory movements ~40; finance ~30; attendance ~40; misc ~50 ⇒ ≈ 380–560 ops/day. At ~550/day × 360 days ≈ 198k. A device pulls its own store + tenant-scoped ops (`api/01 §4.1`), so 200k is a defensible upper bound for one device-year; at ~600 bytes/op it is ≈ 120 MB of log — realistic for the 32GB device. Gates hold at 200k or the gate fails — no "it was close".

### 4.2 Gates

| # | Gate | Budget | Method |
| - | ---- | ------ | ------ |
| **P-1** | Cold start with SEED-200K (NFR-1103) | **< 3,000 ms, every one of 5 cold launches** (not median — the user feels the worst one) | Process start (Activity `onCreate` marker) → notes list rendered **with data** (in-app performance mark). `am start -W` TTID recorded alongside for regression tracking, but the gate is the data-rendered mark. Cold start must not scale with log size — queries hit indexed projections; this gate is the proof. |
| **P-2** | Full projection rebuild of SEED-200K (04 §4.3, FR-1116, NFR-1101) | **≤ 300 s** total; **peak PSS ≤ 400 MB** (`dumpsys meminfo`, sampled every 5 s — headroom under Android low-memory kill on a 2GB device); kill at 50% + resume completes (watermark); UI thread renders a progress indicator ≥ 1 fps throughout (rebuild yields; NFR-1104) | In-app harness. *Budget rationale:* 300 s = 667 ops/s floor — conservative for op-sqlite prepared statements + `executeBatch` in canonical-order folding (all head-case); rebuild is the rare escape hatch, so minutes-with-progress is acceptable, unbounded is not. |
| **P-3** | 1-week backlog sync (FR-1123) | **≤ 60 s** end-to-end: pull 3,500 foreign ops (7 pull batches) + push 500 local ops (1 batch), including projection application. Measured against the harness server over lab Wi-Fi; the gate is processing + protocol chattiness (8 round trips), not carrier bandwidth — 3G behavior is bounded by the batch count, which the gate freezes. | In-app harness against the §2.6 harness server. |
| **P-4** | argon2id PIN verify (stack pin) | **< 300 ms p95** over 20 runs at default params `m = 32768 KiB, t = 3, p = 1`, 32-byte output, via react-native-quick-crypto (async variant — JS thread stays free). If the reference device exceeds 300 ms: drop to the documented floor `m = 19456, t = 2, p = 1`, record the change in `decisions/` and `api/02-auth`, re-run the gate. Never a pure-JS KDF on device. | In-app harness. |
| **P-5** | Command local latency (NFR-1102/1104) | `createNote` execute → append (JCS + SHA-256 + Ed25519 sign via quick-crypto) → projection apply → commit: **p95 ≤ 100 ms** over 200 runs, on top of SEED-200K | In-app harness; measured around the production `execute()` call. |
| **P-6** | Per-op crypto micro-gate | JCS canonicalization + SHA-256 + Ed25519 sign of a representative op: **p95 ≤ 5 ms** (quick-crypto native path — a regression here means someone reintroduced pure-JS crypto on a hot path) | In-app harness, 1,000 iterations. |

Gate results are emitted in the L6 JSON (§2.6) with raw distributions, not just pass/fail — budgets get renegotiated through this doc, never through a silently widened assertion.

---

## 5. What this doc does not own

| Concern | Owner |
| ------- | ----- |
| Op envelope, hashing, chaining, rejection codes | `05-operation-log.md` |
| Sync wire protocol, batching, cursors, backoff | `api/01-sync.md` |
| Module manifest, projection-engine rules, reference-module checklist | `04-module-contract.md` |
| State-machine states asserted here | `03-state-machines.md` |
| PIN lockout machine (schedule, states, offline recovery) | `api/02-auth.md` §6.5 |
| Media chunk protocol, `chunkSize`, server chunk tracking | `api/03-media.md` |
| Label catalog, i18n lint | `07-i18n.md` |
| Permission semantics | `02-permissions.md` |
| Security checklists that generate T-9 adversarial cases | `security-guide.md` |
