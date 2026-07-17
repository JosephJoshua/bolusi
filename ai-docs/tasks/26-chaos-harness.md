# TASK 26 — chaos-harness (@bolusi/harness + test-support determinism kit, multi-device sim, full CHAOS catalog, oracle wiring)

**Status:** in-progress
**Depends on:** 06, 07, 08, 15, 16

## Goal

Deliver `@bolusi/harness` (Node-only, test-only) implementing testing-guide Part B end-to-end: the `Harness(seed, config)` fixture of §3.1 — production `@bolusi/server` in-process on PGlite (reached only via `app.fetch`, no sockets) plus N `VirtualDevice`s, each with its own better-sqlite3 DB behind the §2.3 shim (single connection per device), seed-derived Ed25519 keypair, independently skewable FakeClock, and the real `@bolusi/core` command runtime + projection engine + sync loop — plus the `FaultFetch` wrapper (§3.5 F1–F5 with batch-boundary scheduling) and the raw wire client used exclusively by tamper scenarios. It also delivers the §3.3 determinism kit in `@bolusi/test-support` (mulberry32 PRNG, FakeClock, UUIDv7 IdSource, seeded keypairs, `generateScript` notes-op generator with contention bias and v1→v2 cutover), the canonical-fold reference + convergence assertion built on task 08's `digest()` oracle (§3.4 — consumed, never reimplemented), and the FULL scenario catalog CHAOS-01..12 with each scenario's exact PASS block from §3.6. CI wiring per §3.7 / 08 §5.6: `pnpm chaos` as merge-gate stage 11 (seeds 1–10, CI-scale volumes) and a nightly job (100 logged PRNG seeds, volumes ×4); every failure reproducible from its printed seed alone. The harness contains no protocol logic of its own (T-7) — a capability gap in core/server is a defect filed against its owning task, never forked into the harness. Start is gated by 06/07/08/15/16, but the catalog goes green (= this task done, D4.1 exit gate) only after the surfaces of parallel tasks merge: 25 (notes workload, §3.2), 17 (CHAOS-07 conflict legs), 18/19 (CHAOS-09), 13/14 (CHAOS-11) — do not mark done, skip, or stub those scenarios in the interim.

## Docs to read

- `testing-guide.md` — ALL. Part B §3.1–3.7 is the normative spec for this task (fixture, §3.2 workload requirements, §3.3 kit, §3.4 oracle usage + canonical-fold reference, §3.5 fault points and "every batch boundary", §3.6 catalog PASS blocks, §3.7 CI/D4.1 mapping); Part A T-1..T-10 bind every scenario (esp. T-3 unique values, T-6 determinism/seed printout, T-7 real engine only); §2.1 L4/L5 rows, §2.3 shim + single-connection rule.
- `04-module-contract.md` — §4.2 (head vs re-fold: the two paths CHAOS-01 must provably hit via the engine's public stats), §4.3 (rebuild, watermarks, `rebuild_cursor` — CHAOS-08's resume/monotonicity assertions), §4.4 (manifest-declared columns = the oracle's input), §8 (the reference-module checkboxes this harness proves).
- `05-operation-log.md` — §8 (rejection-code registry — CHAOS-05's exact codes and client behaviors); §4/§5/§6/§9 rows as cited by CHAOS-01/06/04/05 respectively (canonical order, dedupe key, skew threshold, scope rules).
- `api/01-sync.md` — ALL (§2 401/`DEVICE_REVOKED`, §3 batching + `CHAIN_HALTED`/`CHAIN_GAP`, §4–4.2 cursor-after-atomic-apply, devices sidecar, quarantine flow for CHAOS-02/06/12, §6 loop/backoff on fake timers).
- `08-stack-and-repo.md` — §3.1–3.3 (`harness` + `test-support` rows, import matrix incl. the harness→`@bolusi/server` test-only exception), §5.4 (harness location, long timeouts), §5.6 (stage 11 + nightly wiring).
- `security-guide.md` — §12 roll-up row only (disorder-vs-malice split: SEC-* ids are owed by tasks 07/15/16/13/14; this task's adversarial floor is T-9's CHAOS set).

## Skills

- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- `superpowers:test-driven-development` — the §3.6 PASS blocks are the test list; write them first.
- `superpowers:verification-before-completion` — run `pnpm chaos` (all seeds), read the output, before claiming done.
- `superpowers:systematic-debugging` — a red chaos scenario is a real bug somewhere; reproduce by seed, bisect fixture vs engine, never loosen a PASS assertion.

## Files / modules touched

- `packages/harness/src/` — `fixture.ts` (`Harness(seed, config)`, `VirtualDevice`, pre-enrollment seeding, PGlite server boot), `fault-fetch.ts` (F1–F5 + (boundary, point) pair scheduler), `raw-wire.ts` (tamper-only wire client; build payloads with task 07's `test-support/src/oplog-fixtures/` builders — don't duplicate), `canonical-fold.ts` (reference fold + convergence assertion over core's `digest()`, first-differing-row-line diff output), `reporter.ts` (seed printout on failure, nightly seed logging), `volumes.ts` (CI / nightly ×4 / device-reduced parameterization — task 27 reuses scenarios with the op-sqlite driver injected per §2.3, so scenario code stays driver-agnostic).
- `packages/harness/scenarios/chaos-{01..12}-*.test.ts` — one file per catalog entry.
- `packages/test-support/src/determinism/` — mulberry32, FakeClock, IdSource (UUIDv7), seeded keypair derivation (`SHA-256(harnessSeed ‖ deviceIndex)`), `generateScript`. **Shared test-only package** (coordinate per task 07's note — not on the contended list, but tasks 03/04/07/11 own sibling subtrees: touch only `determinism/`); if earlier tasks landed ad-hoc FakeClock/PRNG helpers, consolidate here (one implementation, CLAUDE.md §2.8) — verify first, don't duplicate.
- Root `package.json` scripts (`chaos`, `chaos:nightly`) + CI config: stage 11 merge gate, nightly workflow (100 seeds, ×4 volumes).
- **No changes** to `@bolusi/core`, `@bolusi/server`, `@bolusi/schemas`, `@bolusi/modules` (contended / other tasks' surfaces; T-7). May reuse task 16's `apps/server/test/integration/sync/` fixture helpers read-only.

## Acceptance

**Observable done-condition:** `pnpm chaos` green in CI as merge-gate stage 11 — all CHAOS-01..12 present, seeds 1–10 each, CI-scale volumes exactly as written in §3.6 (CHAOS-02: 1,600+1,600; CHAOS-03: ~14,000; CHAOS-08: 20,000 + 500 interleaved) — no silently reduced volume; nightly workflow runs 100 PRNG-chosen seeds at ×4 volumes with every seed logged. A catalog meta-test (SEC-META-01 style) asserts all 12 scenario ids exist, none `.skip`ped, no vitest retry config anywhere in the package (T-10).

**Determinism (T-6), asserted by meta-tests:**
- Same scenario + same seed run twice → byte-identical oracle digests and identical outcomes/messages.
- Zero real clock/timers/network/RNG: fake timers throughout; all randomness from mulberry32; transport is `FaultFetch(app.fetch)` in-process (no ports); a deliberately-failed run's error output contains the seed (reporter unit test); reproducing a nightly failure locally requires only the seed.

**Determinism-kit unit tests (`@bolusi/test-support`):**
- mulberry32 known-answer sequence for a fixed seed (cross-platform pin).
- IdSource emits valid UUIDv7 (version/variant bits, ms from FakeClock), byte-stable per (seed, clock).
- Keypair derivation reproduces identical noble keys per (harnessSeed, deviceIndex) across runs.
- `generateScript`: exact §3.3 mix for large N (20/60/15/5), recency bias toward the 5 most recent entities, `cutoverIndex` v1→v2 seam honored, per-op FakeClock advance within 1–600 s, whole script identical per seed.

**Fixture + oracle plumbing tests:**
- Each VirtualDevice holds exactly one connection to its own DB; devices pre-enrolled (pubkeys registered, tokens issued) unless a scenario opts out.
- Canonical-fold reference = fresh shim DB + production projection engine fed strictly in `(timestamp ASC, deviceId ASC, seq ASC)` order, then `digest()` (§3.4) — the convergence helper compares every device × server × reference and, on mismatch, prints the first differing JCS row-line.
- `FaultFetch` F1–F5 semantics each unit-tested (F3/F4 = in-memory state discard + DB reopen; F5 = transaction rollback); the (boundary k ∈ [0, B+C]) × (applicable point) enumeration count is asserted.

**Scenario catalog — each of CHAOS-01..12 implemented with its FULL PASS block from testing-guide §3.6, test titles embedding the id verbatim; anything beyond the PASS criteria observed as a diff (extra server ops, extra rows) is a failure:**
- **CHAOS-01** — convergence across shuffled arrival; both head-apply and re-fold engine counters > 0 or fail-as-inconclusive.
- **CHAOS-02** — every (boundary, F1–F5) pair; exactly 1,600 server ops (F2 retries return `duplicate`, never re-insert); digest == canonical fold of 3,200; cursor == final `serverSeq`; F4 no-op / F5 re-apply proven.
- **CHAOS-03** — convergence of ~14,000; per-device pull transferred only missing ops (transfer counts asserted); ≤ 500 ops/batch.
- **CHAOS-04** — A/B accepted with `clockSkewFlagged=true` (never rejected), C accepted unflagged, D unflagged; convergence with future-sorting timestamps.
- **CHAOS-05** — T1–T9 matrix: exact `results[].status` + code per row (via `raw-wire.ts`); rejected ops absent from the server log and all pulls; client keeps them `rejected` + surfaced; untampered devices converge.
- **CHAOS-06** — (a) verbatim batch re-push, (b) DB-clone backup-restore device A′, (c) pull of 50 already-held ops → all `duplicate`/no-op; `serverSeq` values unchanged; every `edit_count` identical before/after.
- **CHAOS-07** — sub-cases (i)/(ii)/(iii): LWW winner asserted against the explicitly computed canonical-last op; tie → greater `deviceId` byte order everywhere; `edit_count` = total edits; Conflict records `minor → auto_resolved` and `significant → surfaced → acknowledged` (both resting transitions exercised; requires task 17 merged).
- **CHAOS-08** — kill at 25/50/75% + resume from `rebuild_cursor` (never re-applies below the watermark); rebuild-with-500-interleaved-ops digest == control device == canonical fold.
- **CHAOS-09** — every chunk boundary × F1–F3 + mid-chunk truncation; assembled SHA-256 == capture SHA-256; no chunk stored twice; `uploadStatus` walks only the permitted path; the referencing op syncs independently (requires tasks 18/19 merged).
- **CHAOS-10** — G1–G5 against the production middleware chain: G1 bomb aborts at the cap with bounded memory asserted, G2/G3 400, G4 413 pre-decompression, G5 200; zero ops persisted from G1–G4 and the follow-up valid push succeeds.
- **CHAOS-11** — schedule imported from the auth package's exported constants (no numeric literals); `delay − 1 ms` refused / `delay` accepted under FakeClock; refusals during delay/lockout never invoke argon2id (KDF spy count unchanged); 10th failure → `locked_out` + `auth.pin_locked_out`; both offline recovery paths with FaultFetch asserting zero network calls; lockout survives restart; clock rollback never shortens `notBefore` (requires tasks 13/14 merged).
- **CHAOS-12** — bad-signature op quarantined immediately; unknown-pubkey op triggers exactly one re-pull with `devicesDirectoryVersion: 0` then quarantined; both in `quarantined_ops`, absent from projections; cursor advances past both; surfaced via `sync.quarantine.*` label key (T-4 — key, not copy); later sidecar releases the unknown-key op via the out-of-order path while the bad-signature op stays; convergence holds.
- §3.7 D4.1 mapping fully satisfied — every decision-D4 clause row has its scenario(s) green.

**SEC ids owned by THIS task:** SEC-DEV-05

**SEC-\*:** SEC-OPLOG-01..09 live with tasks 03/05/07/15, SEC-SYNC-01..10 with task 16, SEC-AUTH with 13/14 (security-guide §12; the harness covers correctness-under-disorder). This task's adversarial floor per T-9 is **CHAOS-05, CHAOS-10, CHAOS-11, CHAOS-12**, shipped and green IN this task before review-wave (CLAUDE.md §2.5).

**SEC-DEV-05 lands here (added by task 61, 2026-07-15).** security-guide §219 requires "Enrollment request payload, **sync bodies, and logs** contain no private-key material (**harness intercepts all outbound requests** during enroll + sync cycle)". `apps/server/test/security/sec-dev.test.ts` proves the enroll-payload leg only (`EnrollReq` is `.strict()`; audit rows carry no private-key bytes) and deliberately keeps the id out of its titles, because a title retires the id whole (§2.1.6). The outstanding leg is the **outbound-request interception** across a full enroll + sync cycle — this task's `FaultFetch` wrapper (§3.5) is the only surface in the repo that sees every outbound request, which is why the id is here and not with 13/14. Ship it under a title embedding `SEC-DEV-05` verbatim, asserting no private-key bytes in ANY intercepted request body or log line (assert the whole captured set, not a sample — T-14), then remove its row from `sec-pending-allowlist.json`.

**Lint/CI gates:** `bolusi/boundaries` — harness imports only `core`, `modules` manifest subpath, `schemas`, `test-support`, `@bolusi/server` (test-only exception), better-sqlite3, PGlite, noble; `harness`/`test-support` never imported by shipping source; no JCS/hash/sign/protocol reimplementation inside the harness (review check; raw-wire builds envelopes via test-support builders + core primitives only); `pnpm lint` + `pnpm typecheck` green; CI stage 11 (`pnpm chaos`, merge gate) and the nightly job added and passing; pre-commit hooks pass without `--no-verify`.
