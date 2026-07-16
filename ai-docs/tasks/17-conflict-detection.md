# TASK 17 — conflict-detection: server rules, system-device emission, platform module, acknowledge

**Status:** in-review
**Depends on:** 07, 08, 16, 46, 47, 48

## Goal

Deliver the v0 conflict machinery end to end. Server side: the detection engine running inside task 16's push transaction — Rule 1 (concurrent conflictKey: accepted op `P` on same (`entityId`, `conflict.key`), `P.deviceId ≠ O.deviceId`, `serverSeq(P) > last_pull_cursor(O.device)`, dedupe per unordered `(opAId, opBId)` pair) and Rule 2 (registered invariant checks; v0 registers exactly `notes:edit_after_archive`) — plus emission of `platform.conflict_detected` by the per-tenant system device: built after the acceptance loop in the SAME transaction, chained via `system_device_chain_state`, signed with the server-held system-device key, `serverSeq` allocated with the same in-loop counter `UPDATE … RETURNING` (10-db §3, normative). Client/shared side: the **platform module manifest in `@bolusi/core`** (01 §6) — registry entries for `platform.conflict_detected` / `platform.conflict_acknowledged` / `platform.user_locale_changed`, the `conflicts` and `user_prefs` projection appliers (one applier, both `ProjectionDb` engines), commands `acknowledgeConflict` and `setLocale`, and a `listConflicts` query gated by `platform.conflict_view`. Severity routing per 01 §8.3: `minor → auto_resolved` (recorded, never surfaced); `significant → surfaced` plus a post-commit server hook carrying push category `conflict` that task 21 will subscribe to — no notification delivery here. Ships the CHAOS-07 fixture (deterministic op scripts + expected classifications) for task 26's harness. Out of scope: conflict/locale UI screens (tasks 24/25), push delivery (21), full multi-device harness runs (26), any DDL change (`conflicts`, `user_prefs`, `system_device_chain_state` exist from tasks 04/05).

## Docs to read

- `01-domain-model.md` — §3.6 (system actor + system device, its ONLY emission path), §5.4 (Conflict entity fields, id = detection-op `entityId`, canonical opA/opB order), §6 (platform op registry — the three op types, emitters, scope rules), §7 (projection list rows: `conflicts`, `user_prefs` only), §8 (Rule 1 / Rule 2 / severity table — the normative detection spec), invariants I-7, I-11
- `03-state-machines.md` — §7 (conflict lifecycle: transitions, transient `detected` + crash re-classification, duplicate-ack total rule, `INVALID_TRANSITION` on bad ack), §11 (N1/N2 rules + notes projection total rules the tests exercise), §12 (`INVALID_TRANSITION` `details` shape)
- `10-db-schema.md` — §3 (push transaction shape incl. the conflict-detection block and in-loop system-op `serverSeq` — normative); `conflicts` / `user_prefs` / `system_device_chain_state` DDL rows in §4/§8/§9.6 as reference only — this task adds NO schema
- `02-permissions.md` — §11.3 (platform permission registry), §12 platform matrix rows + the built-in denial paths (staff vs `platform.conflict_view`/`conflict_acknowledge`)
- `05-operation-log.md` — §9 item 5 only (per-type push rules for the conflict ops — enforced by task 07's pipeline; this task's rejection tests exercise them with the real op types)
- `04-module-contract.md` — §3 (registry entry shape incl. the `conflict` declaration field, `.strict()` payloads, `reversal` docs), §5 (command shape, `DomainError` registry)
- `07-i18n.md` — §1.1 only (`Locale` type, `platform.user_locale_changed` entry detail, `user_prefs` projection)
- `testing-guide.md` — CHAOS-07 (the one CHAOS scenario for this surface)

## Skills

- `superpowers:test-driven-development` — write the detection-matrix table tests before the engine.
- `superpowers:verification-before-completion` — run the test lanes yourself and read the output before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.
- This task mutates `@bolusi/core` (contended, CLAUDE.md §4 / `_index.md` note) — confirm no other core/schemas task is in flight before starting; serialize if so.

## Files / modules touched

- `packages/core/src/platform/` — **CONTENDED `@bolusi/core`**: platform module manifest — `operations.ts` (three registry entries; none declares a `conflict` key — detection ops never cascade), `projections/conflicts.ts`, `projections/user-prefs.ts` (dialect-neutral appliers over `ProjectionDb`, run by the task-08 engine), `commands.ts` (`acknowledgeConflict` w/ surfaced-only precondition; `setLocale` acting-user-only), `queries.ts` (`listConflicts`).
- `apps/server/src/sync/conflict-detection.ts` (+ wiring in task 16's push pipeline module) — Rule-1 detection query, Rule-2 check registry + the `notes:edit_after_archive` registration, pair dedupe, system-device op builder (chain state read/advance, JCS sign via task 07's key access, in-loop serverSeq), in-transaction `conflicts` projection apply, post-commit `onConflictSurfaced` hook (`{ conflictId, tenantId, storeId, category: 'conflict' }`).
- `apps/server/test/` — detection matrix, emission/chain, rejection, and hook integration tests (PGlite lane per existing server-test conventions).
- `packages/test-support/src/fixtures/` — CHAOS-07 fixture: seeded op scripts for sub-cases (i)/(ii)/(iii) + expected classification table (consumed by task 26).
- No DB migrations. No `@bolusi/schemas` changes (payload Zod lives in the manifest).

## Inherited finding — the system-device private key's storage path (from task 13's review, 2026-07-15)

You are the consumer of the system-device signing key, so you own closing this. Task 13's `provision-tenant` CLI currently **prints the system-device private key to stdout** (labeled, alongside the one-time password). review-02 flagged it as a MINOR non-blocker for an operator-run v0 provisioning step, but pushed back on the posture: **stdout lands in terminal scrollback, shell-history-adjacent tooling, and any CI/log capture** — a private key there is not a habit to normalize.

The cheap hardening, either is acceptable: write the key to a file with mode **0600**, or require an explicit **`--print-key`** flag so the *default* path never emits it. Whichever you choose, state which and why.

Constraints: this is a real security surface, so CLAUDE.md §2.5 applies — the change ships adversarial tests before review, and per §2.11 the guard is falsified (prove the default path does NOT emit the key: make it emit, watch the test go red, restore). Do not silently widen scope into task 13's CLI beyond this key-handling change. If `provision-tenant` has since moved or been refactored, adapt and say so.

## Acceptance

- **Detection matrix** (integration tests driving the real push pipeline; each row a named test):
  - Rule-1 hit, both arrival orders (A-then-B and B-then-A): exactly one Conflict row per unordered pair; fields per 01 §5.4 (id = detection-op `entityId`, `conflictKey`, canonical `opAId`/`opBId` order, `storeId` = entity's store); declared `minor` → status `auto_resolved`, still queryable.
  - Rule-1 misses → zero Conflict rows: same device; pusher already pulled `P` (`last_pull_cursor ≥ serverSeq(P)`); same entity but different conflictKey; same key but different entity; op type with no `conflict` declaration.
  - Idempotency: re-pushing a colliding batch (all `duplicate`) creates no second Conflict row and no second system op; per-tenant `serverSeq` stream unchanged.
  - Rule 2: edit-after-archive sequence → Conflict `severity: 'significant'`, status `surfaced`; severity comes from the rule/declaration only (static — no payload-dependent path exists).
  - No cascade: `platform.conflict_detected` / `conflict_acknowledged` / `user_locale_changed` ops never produce Conflict rows (concurrent `setLocale` from two devices asserted → zero conflicts, LWW on `user_prefs`).
- **System-device emission** (10-db §3 mechanics observable):
  - Detection op is inserted in the SAME transaction as the triggering push; `serverSeq` values across accepted + system ops are gapless and contiguous (asserted); `system_device_chain_state` advances (`seq = last_seq + 1`, `previousHash = last_hash`); op carries `source: "system"` and the system user's id.
  - Chain validity: a client pulling the stream signature-verifies and chain-verifies the system device's ops exactly like any member device's (pull-side verification passes; no verification carve-out); a fresh device re-folding from cursor 0 reproduces a digest-identical `conflicts` projection (I-8).
  - Atomicity: a forced abort after detection leaves no `operations` row, no chain-state advance, no counter consumption.
  - Crash re-classification: a persisted `detected` row is re-classified to its resting status on the next engine run (03 §7 self-loop).
- **Rejection / permission-denial (adversarial tests ship IN this task, before review — CLAUDE.md §2.5):**
  - A member device pushes a correctly signed `platform.conflict_detected` → `rejected` / `SCOPE_VIOLATION` (05 §9.5); sibling valid ops in the batch unaffected; no Conflict row, no anomaly-free acceptance path.
  - `acknowledgeConflict` by a user without `platform.conflict_acknowledge` (staff, per 02 §12) → `PERMISSION_DENIED`, denial op emitted (02 §7), no `conflict_acknowledged` op appended.
  - `listConflicts` by staff (no `platform.conflict_view`) → `PERMISSION_DENIED` (never an empty result).
  - No named `SEC-*` id targets this surface (security-guide §12 roll-up: OPLOG/SYNC/AUTH/DEV/MEDIA/TENANT/RT/SECRET/META — those stay with tasks 07/16/13/19/20/28); the three tests above are this surface's adversarial coverage, and SEC-META-01 is unaffected (no new ids).
- **Acknowledge lifecycle:**
  - `surfaced → acknowledged` on ack-op apply, with `acknowledgedBy`/`acknowledgedAt`/`acknowledgementOpId` set, converging on server + a second pulling device.
  - Invalid transitions: acknowledging an `auto_resolved` or already-`acknowledged` conflict → `INVALID_TRANSITION` with `{machine, from, event, entityId}` (03 §12); no op emitted.
  - Duplicate acks merged from two devices: first in canonical order wins, later ones fold as no-ops and create no conflicts (03 §7 total rule).
- **setLocale / user_prefs:** emits `platform.user_locale_changed` with `storeId = null`, `entityType 'user_pref'`, `entityId` = acting user (self-only enforced at the command layer); `user_prefs` folds canonical-order LWW; permitted to every role (staff succeeds).
- **Hook:** the surfaced (significant) path invokes `onConflictSurfaced` exactly once, post-commit, with category `conflict`; the minor path never invokes it; an aborted transaction invokes nothing.
- **CHAOS-07 fixture:** deterministic scripts + expected-classification table for sub-cases (i) distinct timestamps, (ii) forced timestamp tie, (iii) edit-after-archive + owner acknowledgment, committed in `@bolusi/test-support`; this task's integration test drives all three through the real push pipeline and asserts the classification/lifecycle legs (minor → `auto_resolved` ×2; significant → `surfaced → acknowledged`; both resting transitions exercised per D4). The full N-device convergence run lands with task 26.
- **Gates:** `pnpm lint` + `pnpm typecheck` repo-wide (core stays platform-free — boundary lints at `error`); core unit lane + server PGlite lane green in CI; conventional commits, pre-commit hooks intact.

## REGISTRATION REQUIRED (task 49 landed the seam, 2026-07-15)

Task 49 built the server projection-apply step and the **one** registration list it folds from: `SERVER_MODULES` in `apps/server/src/deps.ts`. It is **empty at v0 by design**, and `registerModules(SERVER_MODULES)` derives BOTH the op validators and the projection appliers from it, so they can never name different module sets.

**This task's `defineModule` result MUST be appended to `SERVER_MODULES`, or the server folds nothing** — the op is accepted and its `operations` row is written, but its projection table stays empty in production, silently. That is the exact handoff-ring that left this unbuilt through 8 tasks (task 49's finding). Shipping the applier without registering it is a half-fix that looks done and folds nothing.

**Falsify the registration** (§2.11): with your module registered, push an op through the REAL push path (`processPushBatch`, not a hand-seeded row — T-14b) and assert the projection row appears; then remove your line from `SERVER_MODULES` and watch it go RED. A test that INSERTs its own projection row proves nothing about the fold.

*(For task 17 specifically: `user_prefs` folds from `platform.user_locale_changed`, which this module owns. Until it is registered, task 21's push-notification locale falls back to `id-ID` forever — and task 21's own locale test stays green because it seeds the row directly. That trap is closed only when the platform module both ships the fold AND lands in `SERVER_MODULES`.)*

## Outcome (impl-17, 2026-07-16)

**The premise held, and the trap is closed.**

**Findings filed: tasks 75, 76, 77, 78.** Numbers taken at 2026-07-16 against `main` (files+rows
66–73 present; **71 landed while this task was in flight** — it was a gap when first checked, which
is the moving-tree hazard itself). Originally filed as 74–77 and **renumbered to 75–78** when the
orchestrator reported a 74 in flight on another branch. `_index.md` on this branch is at its branch
point and **lacks rows 71/72/73**; the edits here are the four new rows (appended after 70) plus the
task-17 status flip in **both** locations (row cell + this file's `**Status:**` line — task 71's
two-place rule, which is `in-progress` and must land before this merges).

**Reproduction (T-11), captured before any implementation.** A signed `platform.user_locale_changed`
pushed through the REAL `processPushBatch` over PRODUCTION deps (`resolveDeps()`) was **rejected
`UNKNOWN_TYPE`** and `user_prefs` stayed **EMPTY** (`expected [] to include 'platform'`;
`expected [ 'rejected' ] to deeply equal [ 'accepted' ]`). Both halves are the same one-line absence.

**THE REGISTRATION FALSIFICATION (§2.11) — and the sharpest thing in this task.** With
`platformModule` in `SERVER_MODULES`: 4/4 green. Removed the one line → **3 RED**
(`expected [] to include 'platform'`; `expected [ 'rejected' ] to deeply equal [ 'accepted' ]`;
`expected false to be true`), negative control still green (so the red is attributable to the
registration, not a broken harness). Restored → 4/4.

**`tsc -b` stayed EXIT=0 through the break — and that is the general lesson, not a detail.**
`SERVER_MODULES` is a `readonly AnyModuleDefinition<DB>[]`, and `[]` satisfies that type perfectly.
**A registration list's failure mode is a WELL-TYPED EMPTY LIST.** The type system cannot see a
missing element, a linter cannot, and a green suite cannot — because every test that would notice is
a test somebody has to have written against the *production* list. The only instrument that sees it
is a test driving the real path (`processPushBatch` over `resolveDeps()`) and asserting a row
*appears*. This is the same family as task 39 (`DB` typed `any` → `tsc` green across all of
apps/server) and task 46 (a missing cast `tsc` believed): **the compiler is not a witness for
composition.** Whenever the question is "is X registered / wired / reachable in production?", the
answer must come from executing the production path — never from the fact that it compiles.

**D16 / T-14f — the two lanes, and which proves what.** Rule 1 is
`serverSeq(P) > lastPullCursor(O.device)`: an int8 comparison. It is kept **entirely in SQL**
(`WHERE o.server_seq > d.last_pull_cursor`), so Postgres compares int8 natively and the marshalling
class **cannot arise** — closed by construction, not by a cast someone must remember (task 46's bug
WAS a missing cast `tsc` believed). The query is homed in `@bolusi/db-server`
(`conflict-candidates.ts`) because `pg` is boundary-locked there and `test:rls` is
`--project db-server` — task 49's precedent; the constraint was found independently by review-49 and
now belongs to task 73.

### THE D16 PAIR — task 46's int8 bug, GREEN on PGlite and RED on real PG16, same tree, minutes apart

*(Task 73's acceptance asks for exactly this pair. It is reproduced here on a different bug site —
Rule 1's cursor comparison, not the watermark walk — and it stands on its own. Cite it.)*

**The injected bug** (task 46's, verbatim in shape): in
`packages/db-server/src/conflict-candidates.ts`, replace the in-SQL comparison

```
.whereRef('o.serverSeq', '>', 'd.lastPullCursor')     // Postgres compares int8 to int8
```

with a JS-side comparison — read `devices.last_pull_cursor` into a variable and filter in JS
(`rows0.filter((r) => (r.ss as unknown as number) > cursor)`). `tsc -b` → **EXIT=0**: the type system
asserts `number` and believes it. Nothing else in the repo changes.

**Lane A — PGlite (PG18, in-process), `apps/server` integration:**
```
npx vitest run --project server apps/server/test/integration/sync/conflict-detection.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
EXIT=0                                   ← GREEN. The lane is BLIND to the bug.
```

**Lane B — real PostgreSQL 16.14 over the `pg` driver, attributed (`pnpm test:rls`):**
```
pnpm test:rls
db-server: attribution OK — PostgreSQL 16.14 · db 'bolusi_rls_test' ·
  postgres://bolusi:***@127.0.0.1:32817/bolusi_rls_test · owned by 'agent-aa836efa596653d18'
 Test Files  1 failed | 15 passed (16)
      Tests  1 failed | 132 passed (133)
EXIT=1                                   ← RED. The bug is caught.
 × HIT — cursor 9 vs serverSeq 10: the string comparison says no, int8 says yes  23ms
   AssertionError: expected [] to have a length of 1 but got +0
```

**Restored** (the `whereRef` put back), same command:
```
pnpm test:rls
 Test Files  16 passed (16)
      Tests  133 passed (133)
EXIT=0
```

**Witness file:** `packages/db-server/test/conflict-candidates-pg.test.ts` — it executes the SAME
`findRule1Candidates` the production push path calls (homed in `@bolusi/db-server` precisely so the
real-PG16 lane can reach it; `pg` is boundary-locked there and `test:rls` is `--project db-server`).
Not a copy.

**Why the two lanes disagree:** the real `pg` driver returns `int8` as a **JS string** (int8's range
exceeds JS safe integers, so node-postgres refuses to narrow silently); better-sqlite3 and PGlite
return a **number**. `"10" > "9"` is **false**; `10 > 9` is true. So past cursor 9 the rule silently
stops firing — no throw, no red test, conflicts simply stop being detected in production.

**The sharpest detail, and the one I did not expect:** the **2^53 case stayed GREEN with the bug
present**. `"9007199254740993" > "9007199254740992"` is *true* — equal-length strings compare
correctly, digit by digit. The real class is **differing digit counts** ("10" vs "9"), not "big
numbers". A suite built only from the 2^53 instance I first reached for would have been the bug's
alibi (T-12: test the class, not the instance you thought of). The single test that caught it is
the cursor-9-vs-serverSeq-10 pair.

**Why the shipped code cannot carry the bug:** the comparison is kept **entirely in SQL**, so
Postgres compares int8 natively and no bigint crosses the driver to be compared in JS. Closed by
construction, not by a cast someone must remember — task 46's bug *was* a missing cast that `tsc`
believed (§2.11: make the failure impossible to write, don't ask people to be careful).

**A real bug my own test caught.** Rule 2 first read `notes.archived` — but detection runs AFTER the
acceptance loop, so a device that edits then archives its own note in one batch was reported as
conflicting with itself: exactly the case 01 §8.2's parenthetical excludes ("the editing device had
not seen the archive"). 03 §11 states the rule as ORDER, not state. Now `existsPrecedingOp` asks the
op log whether an archive sorts canonically before the edit.

**Denominator (T-14) — what folds now, and what does not.** `SERVER_MODULES` carries **`platform`**
⇒ **2 of 6** server projection tables fold in production (`conflicts`, `user_prefs`). Still empty:
`notes` (task 25), `auth_sessions` / `pin_lockout_events` / `auth_permission_denials` (task 43) —
their types are `UNKNOWN_TYPE` until they append to the same list. Task 49 measured 0 of 6; this task
moves it to 2 of 6, and the count is stated next to the list in `deps.ts` rather than only here.
Consequence worth naming: `auth.device_enrolled` is still `UNKNOWN_TYPE`, so the registration suite
seeds devices at their post-genesis chain head rather than borrowing task 43's coverage.

**Atomicity, proven through the production path.** A forced failure inside the detection block (the
system signer throws, after Rule 1 matched) rolls back the WHOLE push: the pushed edit's op row and
its fold vanish, no conflict row, `system_device_chain_state.last_seq` still 0. Gapless contiguous
`serverSeq` across accepted + system ops asserted over the whole stream; the detection op is last;
the chain advances `seq = last_seq + 1`, `previousHash = last_hash`; `source: 'system'`.

**The hook.** Fires once, POST-COMMIT (asserted by reading the committed row from OUTSIDE the push
transaction), category `conflict`, for the SIGNIFICANT path only — a batch producing one minor and
one significant conflict fires exactly once. No delivery here (task 21's).

**Contract additions (filed as task 75, not fixed here).** `conflict` (mandated by 01 §8.1, which
says it "extends 04 §3" — but 04 §3 does not list it) and `scope` (01 §6 states the FACT that
`platform.user_locale_changed` is tenant-scoped; the runtime stamped `storeId` from the device for
every draft, so the fact was **inexpressible**). Both follow `schemaVersion`'s precedent: resolved
from the registry, never caller-supplied. 04 is the owning doc and is stale — §4 says that is its
own task.

**Inherited finding (task 13 review-02) — CLOSED, both hardenings.** The CLI printed the tenant's
Ed25519 signing key to stdout unconditionally. **Default now writes a 0600 file and prints only the
PATH**; `--print-key` is an explicit opt-in. Both, because they close different halves: the default
protects an operator who does nothing, and removing the capability entirely would push people to
`cat` the file (scrollback AND disk). `openSync(path,'wx',0o600)` — not `writeFileSync(…,{mode})`,
whose `mode` applies only on CREATE, so writing over an existing 0644 file would silently keep 0644.
Adversarial tests ship with the change (§2.5) and are falsified (§2.11): regressed to the original
unconditional print → the fence went **RED** (2 tests), restored → 6 green. Every case carries its
T-17 positive control (`--print-key` proves the harness CAN see a key on stdout).

**The pre-commit secret scan caught my own fixture, and it was right.** The first key fixture was a
realistic base64 blob; `gitleaks` rejected the commit (`generic-api-key`, SEC-SECRET-02). That line
is character-for-character what a real leak looks like. Fixed the fixture rather than allowlist the
rule — a repo that learns to wave it through on "it's only a test" has disabled the control for the
case it exists for. Never `--no-verify` (§2.10).

**T-8 both-engine conformance** ships for the platform appliers, with a second test that reads the
rows back — because **a digest gate proves the engines AGREE, not that they agree on the right
answer**. Falsified: removed the `status = 'surfaced'` predicate (03 §7's "first ack in canonical
order wins") → the semantics test went RED (`expected 'op-0004' to be 'op-0003'`) while the
**digest test stayed GREEN** — both engines identically wrong. That is the oracle's blind spot,
demonstrated rather than asserted.

**CHAOS-07 fixture** (`@bolusi/test-support`): deterministic scripts + the exhaustive
expected-classification table for all three sub-cases, consumed by task 26. **Five** conflicts total
(3 minor pairs in (i), 1 in (ii), 1 significant in (iii)); both resting transitions covered (D4).
`expectedWinner` is `null` for the forced-tie case BY DESIGN — the fixture cannot know the harness's
runtime deviceIds, and guessing would be a fixture asserting a fact it cannot see (T-14b); §3.6 says
the winner is computed explicitly. Task 17 drives sub-case (i) through the real pipeline: **3 devices
⇒ 3 unordered pairs**, not 1 and not 6.

**T-18 fired twice, on me.** Two full-suite runs notified **"completed (exit code 0)"** with logs of
**3578** and **181 bytes**, no `Test Files N passed` line and no `EXIT=` line — reaped. The first
hid **34 real failures** (my `resolveScope` broke core's runtime fixtures). Had I trusted either
notification I would have shipped a regression. Also learned, and worth writing down: **`npx tsc -b`
does NOT typecheck test files** (it builds the build tsconfigs); `pnpm typecheck` (`tsc -b && pnpm -r
typecheck`) does — my repeated `tsc -b EXIT=0` was never the full typecheck, and two type errors in
my own tests were invisible until I ran the real one.

**Production wiring — closed the ring I nearly left open (the same trap, one layer up).** A trace
found `detectConflicts`/`onConflictSurfaced` accepted by the pipeline but **never passed by the
production route** (`resolveDeps → routes/sync.ts → runPush → processPushBatch`) — a detection engine
tested green through `processPushBatch` that production would never call. Built the composition seam
(`conflict-wiring.ts`): a `SystemKeyStore` port + a DB-backed `systemIdentity` resolver, threaded
through all three layers. Detection is now ENABLED IFF a key store is injected — the honest v0
default, because **no secret-store loader exists** (`config.ts` reads DB+port only; 01 §3.6 gives key
storage to "the deployment doc"). Wired "off by default", NOT "throw when unconfigured": the latter
would 500 the first real collision inside the push transaction and wedge sync for the tenant.
Falsified through `runPush` (dropped the thread → the end-to-end test went RED, construction tests
stayed green). Filed as **task 78** (HIGH): provide a real `SystemKeyStore` — the key-loading
mechanism is a §6 deployment decision. Denominator: with `SERVER_MODULES = [platform]` and no
platform op declaring a conflict, production detects nothing until task 25 registers a conflicting
`notes` type even with a key store — the thread test swaps in a notes-carrying list (what
`SERVER_MODULES` holds post-25) to exercise it today.

### KNOWN GAP — no post-wiring green on the neighbouring sync/oplog tests (for the reviewer)

Stated verbatim, because a gap a reviewer has to infer is a gap nobody checks:

> The final wiring commit (`6e34d5d`) is **additive** — conditional spreads that are no-ops when
> `detectConflicts` is `undefined`, which is what `resolveDeps` produces by default (no
> `SystemKeyStore` in v0). Its own suite is **3/3 with the threading falsified** (dropped the thread
> from `runPush` → the end-to-end test went RED, the two construction tests stayed green →
> restored → 3/3). **But there is no post-wiring green on the neighbouring sync/oplog tests.**

What IS known-green, and its provenance:
- **Full suite `186 files / 2630 passed | 3 skipped, EXIT=0`** — but that run **predates `6e34d5d`**.
  It covers everything else: the platform module, detection engine, conformance, no-cascade,
  CHAOS-07, the CLI hardening.
- `pnpm typecheck` **EXIT=0** and `pnpm lint` **EXIT=0**, both run **after** `6e34d5d`.
- `pnpm test:rls` **16 files / 133 passed, EXIT=0**, attributed to PostgreSQL 16.14, after `6e34d5d`.

Not closed here by instruction: the orchestrator runs the full suite serially in the integration
worktree (this worktree's environment was saturated — three concurrent agents; the server project
wedged at the vitest banner, 76 bytes of output for 600s, which is task 67's load-flake at scale and
not a property of this code). **Do not read the gap as "probably fine" — read it as unrun.**

**Not done / out of scope — stated, not implied.** No client-side command/query integration test
(`acknowledgeConflict`'s `INVALID_TRANSITION`, `listConflicts` staff denial, `setLocale`
`storeId: null` end-to-end) — those need the client command runtime wired to a device DB, which is
tasks 24/25/50's surface; the command/query CODE ships and is typechecked, but its acceptance legs
are **unproven by a running test** and should be a review finding or a follow-up, not assumed. The
member-device `conflict_detected` → `SCOPE_VIOLATION` rejection already ships in task 07's
`steps/scope.ts` (verified by reading it; a mention is not a producer — T-16) and is not re-tested
here. The full N-device convergence run is task 26's.