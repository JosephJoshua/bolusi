# TASK 43 — the auth projections have no appliers and no owner: `auth.*` ops are write-only
**Status:** in-progress
**Priority:** HIGH (a specified audit trail is currently unreadable; nothing fails, which is why nobody noticed)
**Depends on:** 11, 14

## Goal

Ship the **auth module manifest + projection appliers** so `auth.*` ops actually fold into their projection tables.

**The gap** (reported by task 14, confirmed by the orchestrator):

| piece | status |
| ----- | ------ |
| The tables | **exist** — `packages/db-client/src/migrations/001-initial-schema.ts` (task 04); `10-db-schema.md` §549+ defines `auth_sessions`, `pin_lockout_events`, `auth_permission_denials` explicitly as *projections of* `auth.user_switched` / `auth.session_ended` / `auth.pin_locked_out` / `auth.pin_lockout_cleared` |
| The ops | **exist and are emitted** — task 10's five sanctioned runtime emissions (`auth.user_switched`, `auth.session_ended`, `auth.permission_denied`, `auth.pin_locked_out`, `auth.device_enrolled`); task 14 ships `authOperationRegistry` (op type → schemaVersion) |
| The appliers that fold ops → tables | **do not exist, and no task file claims them** |

So the ops are appended, chained, signed, and synced — and the projection tables stay **empty**. Every query against them returns nothing.

**Why this is HIGH and not cosmetic.** `auth_permission_denials` is the **audit trail `02-permissions` §7 / FR-1045 specifies**. Task 09 built the evaluator to emit a denial op on every denial; task 10 built the emission channel and made the deny unconditional on the audit succeeding. All of that work lands in an op log that **nothing reads back**. The fraud model's paper trail is write-only. Nobody noticed because **nothing fails**: no error, no red test — the ops are valid, the tables are valid, and the join between them simply doesn't exist. That is this project's signature failure shape (see CLAUDE.md §2.11) in a new place: not a guard that checks nothing, but a *feature that is absent rather than broken*.

**Precedent for the shape:** task 17 owns the **platform** module manifest (`platform.conflict_detected` / `conflict_acknowledged` / `user_locale_changed` + the `conflicts` and `user_prefs` appliers). The decompose gave platform an owner and gave auth none. This task is auth's equivalent.

## SCOPE ADDITION (2026-07-15, from the orphan sweep) — `listPermissionDenials` is yours, and this task's own falsification currently can't run

`02-permissions.md` §7 closes the FR-1045 audit trail with a **named read path**: *"Read via auth query **`listPermissionDenials`**, permission **`auth.audit_view`**, cursor-paginated (04 §6)."* `10-db §10` lists it as a **both**-side query.

**Everything around it was built. The query wasn't:**
- permission **seeded** — `packages/db-server/migrations/0008_seed_permissions.ts:116`
- permission **registered** — `apps/server/src/identity/permission-registry.ts:118`
- an index created **specifically to serve it** — `packages/db-server/migrations/0005_media_push_projections.ts:158-160`, trailing comment literally `// listPermissionDenials (auth.audit_view)`
- the query itself: exists **only in a test fixture** (`packages/core/test/authz/_fixtures.ts:88`)
- **zero task files own it** (verified: `grep -rln "listPermissionDenials" ai-docs/tasks/` → nothing)

**And it breaks this task's own Acceptance.** The falsification step above says *"break the applier, watch the audit query go empty/wrong, restore"* — **that presupposes a query that does not exist.** As written, this task's falsification is unexecutable. That's my error in filing it: I specified a check against a read path nobody had built, which is the same shape as the bug this task exists to fix.

**So it is in scope here** — task 17's platform manifest explicitly enumerates `queries.ts` (`listConflicts`); this task had no equivalent line. Ship `listPermissionDenials` in the auth manifest's `queries.ts`: cursor-paginated per `04 §6`, gated by `auth.audit_view` through task 11's query runtime (the gate decides what is **SELECTed** — never sent-then-hidden, `02 §9`). Then the falsification above becomes real: break the applier → the audit query goes empty → restore → it reads back.

**Assert the fixture before believing the read** (T-14b): a query returning nothing proves nothing unless you first assert the denial ops **exist** in the log. That is exactly how a write-only audit trail looks green.

## Docs to read

- `04-module-contract.md` §1-4 — `defineModule`, the operation registry, appliers (task 11 shipped these; consume, do not rebuild). §2 — appliers are **dialect-neutral**.
- `10-db-schema.md` §549+ — the three tables' DDL and the ops each projects from. This is the contract.
- `api/02-auth.md` §6.2 — what `auth_sessions` / `pin_lockout_events` must contain.
- `02-permissions.md` §7 — the `auth.permission_denied` payload (six fields) + the suppression/throttle semantics; FR-1045.
- `ai-docs/tasks/17-conflict-detection.md` — the platform module manifest, as the pattern to mirror.
- `testing-guide.md` **T-8** (both-engine rule — mandatory here), §2.4 (applier conformance suite), T-11, T-14b.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/auth/` — the module manifest + appliers (task 14 landed the auth runtime here). **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize.
- Possibly `packages/test-support/` — applier conformance registration.
- **Do NOT** add DDL: all three tables already exist (task 04). If one is missing a column the applier needs, STOP and report — migrations serialize globally.

## Acceptance

**Observable done-condition:** emitting each `auth.*` op through the real runtime and folding through the real projection engine populates its table — and the applier conformance suite passes on **both** engines.

- **Prove the gap first** (T-11): emit `auth.user_switched` through the runtime today, fold, and show `auth_sessions` is **empty**. That empty table is the bug. Same for `pin_lockout_events` and `auth_permission_denials`. If any is already populated, the premise is wrong — stop and report.
- **Ship the manifest + appliers** via task 11's `defineModule`, mirroring task 17's platform-module shape. Register the ops against `authOperationRegistry` (task 14 shipped it — consume it, do **not** fork a second registry; §2.8, and this repo already has a task-33 pile of duplicate registries).
- **Both-engine rule is mandatory (T-8)** — the appliers run through the shared applier conformance suite against SQLite *and* PGlite with oracle-equal digests. Note what this gate caught the first time it ran for real (task 11): `MAX(a,b)` is a scalar in SQLite and an **aggregate** in Postgres, and ms-epoch overflows a 32-bit `integer` while SQLite swallows it. Write the appliers dialect-neutral from the start and let the gate prove it.
- **The denial projection is the load-bearing one** (§7): `auth_permission_denials` must reflect the six-field payload (`permissionId`, `surface`, `target`, `reason`, `scopeStoreId`, `suppressedRepeats`) and the **suppression** semantics — a suppressed repeat must not vanish from the audit; it increments `suppressedRepeats`. **Falsify** (§2.11): break the applier, watch the audit query go empty/wrong, restore. **Assert the fixture before believing a count** (T-14b) — a projection test that passes over zero ops proves nothing.
- **Assert outcomes, not mechanisms** (task 10/11's lesson): assert *"the denial is readable from `auth_permission_denials` with the right reason"*, not *"the applier was called."*
- **Denominator** (T-14): every op type in `authOperationRegistry` has an applier or a stated reason it doesn't project. Name the count; a registry entry with no applier and no reason is the gap this task exists to close, recurring.
- `pnpm test`, `pnpm test:appliers`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by task 14, which shipped `authOperationRegistry` and then said plainly: *"`auth_sessions` / `pin_lockout_events` / `auth_permission_denials` have no appliers anywhere and no task owns them."* It could have shipped its own surface green and left this silent — the tables aren't its deliverable and no test of its was red. It reported it instead.

Worth stating for the decompose: this is the **third** artifact this session that was specified, built halfway, and orphaned because the graph named no owner (after the permission registry and the `@bolusi/schemas` auth DTOs, both now task 33). The pattern is consistent — **a table with no applier, like a shared contract with no owning task, fails by being absent rather than broken**, and absence is exactly what a green test suite cannot see.

## REGISTRATION REQUIRED (task 49 landed the seam, 2026-07-15)

Task 49 built the server projection-apply step and the **one** registration list it folds from: `SERVER_MODULES` in `apps/server/src/deps.ts`. It is **empty at v0 by design**, and `registerModules(SERVER_MODULES)` derives BOTH the op validators and the projection appliers from it, so they can never name different module sets.

**This task's `defineModule` result MUST be appended to `SERVER_MODULES`, or the server folds nothing** — the op is accepted and its `operations` row is written, but its projection table stays empty in production, silently. That is the exact handoff-ring that left this unbuilt through 8 tasks (task 49's finding). Shipping the applier without registering it is a half-fix that looks done and folds nothing.

**Falsify the registration** (§2.11): with your module registered, push an op through the REAL push path (`processPushBatch`, not a hand-seeded row — T-14b) and assert the projection row appears; then remove your line from `SERVER_MODULES` and watch it go RED. A test that INSERTs its own projection row proves nothing about the fold.