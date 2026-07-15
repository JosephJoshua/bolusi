# TASK 08 — projection-engine

**Status:** in-review
**Depends on:** 04, 06

## Goal

Deliver the `@bolusi/core` projection engine exactly per 04-module-contract §4: applier registration from the §4.4 manifest shape (columns, `primaryKey`, `entityIdColumn`, `projectionVersion`), and the runtime-owned order-independence guarantee of §4.2 — incremental head-apply when an op is canonically newest for its entity, entity-local delete + full canonical-order re-fold otherwise, so appliers never see out-of-order input. It also delivers §4.3 watermarks (`applied_server_seq` = highest contiguous serverSeq from pull, `applied_local_seq` = own-device appends, both strictly monotonic, never moved by entity-local re-fold), full rebuild iterating the canonical-order index with a persisted `rebuild_cursor` (last canonical `(timestamp, deviceId, seq)` triple; stored as an engine-owned key in `meta_kv`, 10-db §9.1 — no new tables) so interrupted rebuilds resume, the engine-neutral convergence-oracle `digest()` implementing testing-guide §3.4 byte-for-byte, per-table live-query invalidation hooks per 04 §7, and public head-apply / re-fold counters (CHAOS-01 fails as inconclusive without them). Everything is platform-free and works against injected ports only: a `ProjectionDb` Kysely handle restricted to the dialect-neutral subset (04 §2), an op-log reader in canonical order backed by task 06's local log (`idx_operations_entity_canonical`, 10-db §9.2), and a watermark store whose interface both the client table (10-db §9.1, both columns) and the server table (10-db §8, `applied_server_seq` rebuild-bookkeeping only) can satisfy — only the client shape is exercised here; server embedding lands with tasks 07/16. No sync loop, no command runtime, no harness scenarios (tasks 15, 10, 26). **Contended `@bolusi/core`** — serializes with tasks 02/06/10/11 per `_index.md`.

## Docs to read

- `04-module-contract.md` — §2 (ProjectionDb, dialect-neutral subset), §4.1–4.4 (the whole contract for this task), §7 live-query invalidation rule only.
- `05-operation-log.md` — §4 (canonical total order; serverSeq is never business order), §5 (idempotency by op `id`).
- `10-db-schema.md` — §9.1 (`projection_watermarks`, `meta_kv`), §9.2 (`idx_operations_entity_canonical` + append-only note), §8 server `projection_watermarks` comment block, §10 rows for re-fold/rebuild.
- `testing-guide.md` — §2.1 (L1/L2), §2.3 (better-sqlite3 behind the `kysely-generic-sqlite` shim — the CI engine for these tests), §3.4 (oracle spec — normative for `digest()`), §3.6 CHAOS-01/06/07/08 (what the tests below are precursors to; do NOT build the scenarios here — task 26).
- `08-stack-and-repo.md` — §3.2 `@bolusi/core` row, §3.3 import boundaries, §3.4 platform-free locks, §5.4 vitest layout.

## Skills

- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the suite, read the output, before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched

- `packages/core/src/projection/` — **CONTENDED (`@bolusi/core`, CLAUDE.md §4)**: registry (manifest → applier/table lookup), engine (head-apply vs re-fold dispatch), `rebuild.ts` (cursor checkpoint + resume), `watermarks.ts` (store interface + semantics), `oracle.ts` (`digest()`), `invalidation.ts` (per-table hook bus), `stats.ts` (public counters), exported from the package root.
- `packages/core/src/projection/*.test.ts` — colocated unit/property tests (08 §5.4), running on better-sqlite3 `:memory:` behind the shim dialect (testing-guide §2.3), test-only devDependency; shipping source stays §3.3/§3.4 clean. Seeded PRNG helpers stay local to test files until task 26 lands `@bolusi/test-support`.
- Touches nothing in `@bolusi/schemas`, `db-client`, `db-server`, or spec docs. Any need for new DDL (e.g. a dedicated rebuild-cursor table) is a stop-and-ask red flag (CLAUDE.md §6) — `meta_kv` is the sanctioned scalar store.

## Acceptance

**Observable done-condition:** `pnpm --filter @bolusi/core test` green in CI (L1/L2 lanes, existing vitest project — no new CI stage); the engine API (register, apply, rebuild/resume, digest, invalidation subscribe, stats) exported and consumed only via injected ports.

**Tests to add (concrete; each prints its seed on failure, asserts with per-seed values):**

1. **Head vs re-fold dispatch:** canonically-newest op for its entity → exactly one applier call, no entity delete (recording applier + stats assert); op sorting before an already-applied op for that entity → entity rows deleted by `entityIdColumn` and full entity history re-folded strictly in `(timestamp, deviceId, seq)` order — the recording applier proves it never observed out-of-order input on either path.
2. **Out-of-order convergence property test (precursor to CHAOS-01):** seeded script, ≥3 device ids, same-entity contention; for each of seeds 1–10, apply in multiple random permutations → every permutation's `digest()` byte-equal to the canonical-fold reference (fresh DB, ops fed strictly in canonical order). Both stats counters > 0 or the test fails as inconclusive.
3. **Re-fold correctness on mid-history insert:** full history applied, then an op whose canonical position is mid-history arrives → digest equals fresh canonical fold of the full set; an `edit_count`-style counter column proves nothing was double-applied or dropped.
4. **Rebuild == incremental equivalence (precursor to CHAOS-08):** CI-scaled history (≥2,000 ops) applied incrementally vs drop-tables + full rebuild → byte-equal digests; `projectionVersion` bump triggers rebuild.
5. **Watermark monotonicity (incl. re-fold non-movement):** `applied_server_seq` advances only across contiguous serverSeq (a gap pins it below the gap until filled); `applied_local_seq` strictly monotonic on appends; an entity-local re-fold moves **neither**; no operation, including rebuild resume, ever decreases either.
6. **Interrupted-rebuild resume (precursor to CHAOS-08a):** discard in-memory state + reopen DB at ~25/50/75% through a rebuild → resume continues from `rebuild_cursor`; recording applier asserts no op at-or-below the cursor is re-applied; final digest == uninterrupted-rebuild digest.
7. **Idempotency (precursor to CHAOS-06):** re-delivering an already-applied op `id` is a no-op — digest and counter columns byte-identical before/after.
8. **Deterministic tie-break (precursor to CHAOS-07ii):** identical `timestamp`, distinct `deviceId` → greater deviceId (byte order) wins, on every permutation.
9. **Oracle conformance (testing-guide §3.4, item by item):** manifest-declared columns in declaration order only; excluded tables (op log, watermarks, bookkeeping) never digested; normalization table exercised — NULL, >2^53−1 integer → decimal string, boolean-declared 0/1, blob → lowercase hex, and a float value → **oracle ERROR** (asserted); rows sorted in JS by UTF-8 byte order (no SQL ORDER BY); row lines via the shared JCS implementation.
10. **Invalid input / failure atomicity:** op whose `type` has no registered applier → defined, tested behavior (no partial writes); applier throwing mid-re-fold → transaction rolls back: entity rows not left deleted, watermarks unmoved.
11. **Invalidation hooks:** after a batch applies, hooks fire once per written table (per-table granularity, no row payload — 04 §7); re-fold and rebuild fire hooks for affected tables; untouched tables stay silent.

**SEC-\*:** none belong to this surface — security-guide names no SEC-PROJ tests; SEC-OPLOG-02/09 and SEC-SYNC-07 assert projection effects but ship with tasks 07/15/16. This task's security obligation is negative: the engine writes only projection tables + its own bookkeeping, keeping the security-guide append-only lint rule (no UPDATE/DELETE on operations tables) satisfiable — add no op-table write.

**CHAOS-\*:** CHAOS-01, CHAOS-06, CHAOS-07, CHAOS-08 exercise this engine but are task 26 deliverables; this task must ship every engine capability they require — public head/re-fold stats (CHAOS-01), idempotent apply (CHAOS-06), canonical LWW + tie-break (CHAOS-07), cursor-resumable rebuild (CHAOS-08) — via tests 2, 7, 8, 6 above.

**Lint/CI gates:** platform-free locks pass (08 §3.4: `"types": []`, boundary ESLint — no node/RN/driver imports in shipping source); `pnpm lint`, `pnpm typecheck`, root `pnpm test` green; pre-commit hooks never bypassed; Conventional Commit subjects only.
