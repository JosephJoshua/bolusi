# TASK 27 — device-gates (on-device performance gates, Part C)
**Depends on:** 24, 25, 26

> **27b UPDATE (2026-07-22, D21) — the Part C performance gates are ASSUMED-PASS, DEVICE-UNVERIFIED, and 27b no longer blocks v0.**
> The owner ruled (`decisions/2026-07-22-assume-device-performance-passes.md`): proceed as if P-1…P-6 pass on the physical 2 GB reference device.
> - **This is an assumption, not a measurement.** No Part C gate has run. No p95, no ops/s, no cold-start figure, no PSS figure exists for this task — none has been observed and none may be written as though it had (CLAUDE.md §2.1; D21's own rule). The only honest form for any downstream claim is *"assumed to pass per D21 (owner ruling, 2026-07-22); unverified on device."*
> - **What the assumption resolved:** **D8** — the argon2id default `m=32768/t=3/p=1` ships and the documented floor is NOT engaged (`api/02-auth.md` §5.3; the default is the stronger profile, so the assumption lands conservatively). **D6** — the op-sqlite throughput rationale is ratified, swap-target wrapper unaffected (`decisions/2026-07-14-v0-stack-pins.md`).
> - **Assumed, not deleted** — D12's "blocked, not deleted" precedent applied to an assumption. The gate definitions, the budget constants (`apps/mobile/src/harness/part-c/budgets.ts`, mirroring testing-guide §4.2 verbatim), the harness, and `pnpm harness:device` all stay **exactly as they are**, so a real device can still run them and either **confirm or refute** this assumption. A widened constant is still a spec change, not a fix.
> - **27b's status stays `blocked`, and that is not a contradiction.** D21 removed 27b from v0's exit path; it did not supply hardware. The lane is still unrunnable (no physical 2 GB device), so `blocked` remains the honest token — `todo` would advertise work nobody can pick up, and `done` would be both false and a live gate failure (SEC-AUTH-10's allowlist row would go stale). What D21 changed lives in `_index.md`'s exit line and this note, not in a status token. **Mechanic worth knowing before you touch it:** `27a`/`27b` are two rows against this ONE file. Task 188 collapsed the dual Status store, so `pnpm task:status` now edits **only the `_index.md` row cell** — there is no file `**Status:**` line left for a `27b` write to also rewrite, so the two lanes are independent and updating one never disturbs the other. Task 27 counts as done only when **both** rows are `done` (`doneTaskNumbers` reads every row for the number), so 27b staying `blocked` keeps SEC-AUTH-10's allowlist row correctly non-stale.
> - **SEC-AUTH-10 is NOT discharged.** Its acceptance is a *recorded on-device benchmark committed as a build artifact*; an assumption produces no artifact. It stays on `sec-pending-allowlist.json` (owned here), and it retires only when a device produces the artifact — retiring it against a params-pinning test would be moving the yardstick (CLAUDE.md §2.11).
> - **Untouched by D21:** everything correctness-shaped. SEC-DEV-06's L6 at-rest leg and SEC-AUTH-09 leg 1 are yes/no byte questions for **27a**'s emulator lane, not performance claims; the SEC-OPLOG-06 JCS vectors are deterministic per Hermes build (D13). No assumption is available to any of them.

## Goal
Deliver the L6 on-device performance lane: the hidden Harness screen's Part C section in `apps/mobile` (compiled only under `BOLUSI_TEST_HARNESS=1`, EAS `test` profile), the `SEED-200K` deterministic generator in `@bolusi/test-support`, and the `pnpm harness:device` adb driver script that runs all six Part C gates (P-1…P-6, testing-guide §4.2) plus an op-log raw write-throughput benchmark on the physical 2GB reference device, release-variant build. The run captures the `BOLUSI_HARNESS_RESULT` logcat JSON (raw distributions, not just pass/fail) into a committed report file. Two decisions get recorded from the numbers: the argon2id KDF params (default `m=32768/t=3/p=1` kept, or the documented floor `m=19456/t=2/p=1` engaged — resolves the P-4 / D8 open question) and the op-sqlite write-throughput figures vs the D6 expectation (P-2's 667 ops/s floor). CHAOS-01/03/06/07 at reduced volume ride the same on-device run per testing-guide §2.6, reusing task 26's scenario machinery unchanged — no scenario logic is authored here. No changes to `@bolusi/core` or `@bolusi/schemas`: P-5 measures the production `execute()` as-is.

## Docs to read
- `testing-guide.md` — §2.6 (L6 on-device suite: harness screen, `BOLUSI_HARNESS_RESULT` JSON, `pnpm harness:device`, release-variant requirement, reference device); §4 Part C in full (§4.1 SEED-200K spec, §4.2 gates P-1…P-6 with budgets + methods); §3.3 (determinism kit + op script generator the seed scales)
- `08-stack-and-repo.md` — §5.5 (EAS `test` profile / harness flag), §5.6 stage 12 (device lane), §3.1–§3.2 (`@bolusi/test-support` / `apps/mobile` responsibilities + import boundaries)
- `decisions/2026-07-14-v0-stack-pins.md` — D6 (op-sqlite: `executeBatch` + prepared statements, "device write benchmark required before freezing throughput numbers"), D8 (quick-crypto argon2id default params + documented floor)
- `security-guide.md` — SEC-AUTH-10 row only (KDF benchmark output committed as artifact)

## Skills
- superpowers:test-driven-development (always)
- superpowers:verification-before-completion — gate claims come from the captured device JSON, never from a summary (CLAUDE.md §2.1)
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/test-support/src/seed/seed-200k.ts` — SEED-200K generator (scales the §3.3 `generateScript`; seed 42; not a contended package)
- `apps/mobile/src/harness/part-c/` — gate runners P-1…P-6 + write-throughput benchmark, budget constants, result JSON emitter (extends the harness screen shell; flag-gated)
- `apps/mobile/src/` — cold-start instrumentation only: Activity `onCreate` marker + notes-list "rendered with data" performance mark (touches app-shell entry from 24 and the notes list screen from 25; no behavior change)
- `apps/mobile/eas.json` — verify/complete the `test` profile per 08 §5.5 (exists from 24; adjust only if the flag wiring is missing)
- `scripts/harness-device.ts` + root `package.json` — `pnpm harness:device` (adb-driven, fails non-zero on any red)
- `reports/device-gates/` — committed captured report(s), e.g. `reports/device-gates/2026-MM-DD-seed200k.json`
- `ai-docs/decisions/<date>-device-benchmarks.md` — new decisions entry (KDF params + write-throughput)
- `ai-docs/api/02-auth.md` — edited ONLY if the P-4 floor engages (required by testing-guide §4.2 P-4; this doc edit is in-scope for this task, not a side effect)
- Contended packages (`@bolusi/schemas`, `@bolusi/core`, `@bolusi/ui`): **not touched**.

## Acceptance
- **Observable done-condition:** `pnpm harness:device` against the physical 2GB reference device (EAS `test` profile, release variant — dev-mode runs are rejected by the script via a build-variant check in the result JSON) executes all Part C gates + the write benchmark + CHAOS-01/03/06/07 at reduced volume, exits 0, and the captured `BOLUSI_HARNESS_RESULT` JSON (with raw distributions per gate) is committed under `reports/device-gates/`.
- **Gate assertions (each pass/fail against budgets pinned as code constants that mirror testing-guide §4.2 verbatim — a widened constant is a spec change, not a fix):**
  - P-1: < 3,000 ms on **every one of 5** cold launches, `onCreate` → notes-rendered-with-data mark; `am start -W` TTID recorded alongside in the report.
  - P-2: SEED-200K full rebuild ≤ 300 s; peak PSS ≤ 400 MB (`dumpsys meminfo` sampled every 5 s, samples in report); kill-at-50% + resume completes via watermark; progress UI ≥ 1 fps throughout.
  - P-3: 1-week backlog (pull 3,500 ops / 7 batches + push 500 / 1 batch, incl. projection apply) ≤ 60 s against the §2.6 harness server over lab Wi-Fi.
  - P-4: argon2id verify p95 < 300 ms over 20 runs at `m=32768 KiB, t=3, p=1`, async variant; on failure, engage floor `m=19456, t=2, p=1` and re-run green.
  - P-5: `createNote` execute→append→apply→commit p95 ≤ 100 ms over 200 runs on top of SEED-200K, measured around the production `execute()`.
  - P-6: JCS + SHA-256 + Ed25519 sign p95 ≤ 5 ms over 1,000 iterations.
  - Write benchmark: raw op-log append ops/s via prepared statements + `executeBatch` on top of SEED-200K, reported (no budget gate; recorded vs the P-2 667 ops/s floor).
  - **SEC-DEV-06 L6 leg — assert the plaintext control before trusting ciphertext absence (testing-guide T-14b).** `@bolusi/test-support/src/driver-conformance/at-rest.ts` seeds `plaintextMarkers` and asserts their ABSENCE from the encrypted DB file. A silent seed no-op makes "no plaintext found" pass vacuously — the same family as the parse-collapse and the RLS empty-fixture traps. The device ctx MUST first write the markers to an UNENCRYPTED control DB and assert they ARE byte-present there, before trusting their absence in the SQLCipher file. Without the positive control, this probe proves nothing — and it is the ONLY thing that ever exercises real SQLCipher (CI has none). Falsify it: point the probe at a plaintext DB and watch it report the leak. (The CI unit test is safe — explicit injected byte arrays, no live seed — so this binds the device ctx only.)
- **Decisions recorded (checkable in the diff)** — this acceptance leg is about a REAL RUN and **D21 did not satisfy it**: an assumption records no measurement, so the entry below is still owed by the first device run (the 27b update at the top says which decisions D21 resolved *by assumption* instead). `ai-docs/decisions/<date>-device-benchmarks.md` exists stating (a) measured P-4 p95 and which KDF params are pinned — 32 MiB default kept or floor engaged (if floor: `api/02-auth.md` updated in the same PR); (b) measured write-throughput vs D6 expectations. Report file referenced by path from the entry.
- **Tests to add (Node, run in CI on every PR):**
  - SEED-200K determinism: two generations at seed 42 produce byte-identical digests; composition assertions — 200,000 ops, ~20,000 entities × ~10 ops, 5,000 MediaItem metadata rows, v1→v2 cutover exactly at op 100,000 (v1 payload at op 99,999 / v2 at op 100,000); invalid input: non-42 seed produces a different digest (no hardcoded output).
  - Budget-constants test: the pinned constants equal the §4.2 table values (guards silent widening).
  - Flag gating: harness/Part C module is unreachable when `BOLUSI_TEST_HARNESS` is unset, and a static check asserts `eas.json` sets the flag ONLY in the `test` profile (never `production`/`preview`).
  - `harness:device` driver: unit test on the result-JSON parser — any gate red, missing gate, or missing release-variant marker ⇒ non-zero exit (no partial-pass idempotency hole: re-running against a stale/absent logcat capture fails, never reuses a prior result).
**SEC ids owned by THIS task:** SEC-AUTH-10

- **SEC-\*:** SEC-AUTH-10 (on-device KDF benchmark recorded, output committed as build artifact — satisfied by the P-4 run + committed report + decisions entry; assert the artifact path exists in the driver's post-run check). No other SEC-* belongs to this surface (adversarial sweep is task 28).
- **CHAOS-\*:** CHAOS-01, CHAOS-03, CHAOS-06, CHAOS-07 at reduced volume execute in the same L6 run (testing-guide §2.6) using 26's scenarios; their pass/fail appears in the same JSON. CHAOS-08 remains Node-side in 26 — P-2 is its device counterpart (§3.5 mapping).
- **Lint/CI gates:** `pnpm lint` / `pnpm typecheck` / `pnpm test` green (boundary rules: `@bolusi/test-support` imported only from harness/test entry points, 08 §3.4); adds the 08 §5.6 stage-12 device-lane entry (`harness:device` invocation documented in the CI config, triggered on native change/scheduled — not per-PR).

## 27a — FIRST REAL GATE VERDICTS ON-DEVICE 2026-07-25 (emulator run 30153400999, sha 12d5b66)
After 148/162/176/175/177/178 the Android emulator lane produced its first real per-gate verdicts on a
booted AVD (`reports/device-gates/2026-07-25-emulator.json`): **SEC-DEV-06-at-rest, SEC-AUTH-09-leg1,
SEC-OPLOG-06-jcs all PASS** (real production-writer seed, T-14b positive control, shared RFC-8785
vectors on Hermes). CHAOS-01/03/06/07 honestly `skipped` — no on-device runner (task 181). The lane
exits non-zero BECAUSE of the 4 honest skips (correct §2.11 outcome), not a gate failure. 27a's 3
correctness/security legs are DONE; 27a goes fully GREEN when 181 lands the 4 chaos runners.

## COUPLED WORK — re-land task 160 in THIS lane's next run (owner-ruled 2026-07-26: defer 160 to 27a)
Task 160 (the boot key-tag self-heal) was built, reviewed, merged, then **reverted** on 2026-07-25
because its probe exposes the column-cipher marker on `packages/db-client/src/connection.ts` — an
`AT_REST_SURFACE` file — which correctly staled the SEC-AUTH-09 provenance (the `2026-07-25-emulator.json`
artifact above certifies the PRE-160 at-rest code). The owner ruled to defer 160's re-land to this lane
rather than dispatch a one-off emulator run. **So the NEXT time this emulator lane runs (e.g. for 181's
chaos runners, or the api-level-36 raise in 167), do it over a tree that has re-landed 160**, and:
1. Restore branch `task/160-boot-decrypt-probe` (commits `78edee6`+`af2210d`, reviewed) onto main first.
2. The fresh emulator run then certifies SEC-AUTH-09-leg1 over 160's `connection.ts` — a NEW artifact.
3. Commit the new artifact and **re-anchor** `packages/harness/src/security/device-gate-provenance.ts`
   to the new artifact's commit (re-anchoring without a real run = §2.11 "move the yardstick").
4. Push the branch and read CI per-job (`gh run list` → per-job conclusions): `security-gate` green,
   only `security-owed` red (SEC-AUTH-10 owed), before the ff. See task 160's re-land checklist and
   task 182 (stamp a build-sha in the artifact — do it in the same schema touch if convenient).
Ordering matters: 160 must be live before 27a enrolls on real hardware (a restored foreign DB is only
reachable once a device DB exists — 27a is the first), so this is the natural place to land both.
