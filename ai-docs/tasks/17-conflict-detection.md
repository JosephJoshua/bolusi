# TASK 17 — conflict-detection: server rules, system-device emission, platform module, acknowledge

**Status:** in-progress
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