# TASK 187 — dedup extractions surfaced by the 186b-1 review: the DomainError->code:'UNEXPECTED' mapping (4 copies) and the live-shell DeviceBundle seed scaffold (3 copies)

**Status:** todo
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the task 186b-1 review-wave (duplication lens), 2026-08-05.

## Goal

Two small, independently-shippable extractions the 186b-1 review confirmed. Neither is a 186b-1 blocker (186b-1 added one more copy of each, which is what tripped the rule-of-three); both are behavior-preserving refactors.

### 1. `DomainError → code | 'UNEXPECTED'` mapping — 4 byte-identical copies

The expression `error instanceof DomainError ? error.code : 'UNEXPECTED'` (map a caught error to a closed catalog CODE, never a raw string) exists at four sites, two already named helpers:

- `packages/modules/src/notes/screens/runtime.tsx:128` — a named helper (returns the code).
- `apps/mobile/src/media/CaptureHost.tsx:101-102` — `codeOf(error)`, a named helper.
- `apps/mobile/src/bootstrap/session.ts:322` — inline (`usersError = …`).
- `apps/mobile/App.tsx:381` — inline (the 186b-1 target-list load rejection handler — the 4th copy).

**Proposed home:** `@bolusi/core` (where `DomainError` lives, platform-free) — e.g. `errorCodeOrUnexpected(error: unknown): string` in `packages/core/src/errors/`. Both `@bolusi/modules` and `apps/mobile` already depend on core, so all four adopt it. Confirm `'UNEXPECTED'` is the right shared fallback (it is a `core.errors.*` catalog key) before homing it in core; if a UI-fallback concern argues against core, a mobile-local util reachable from both mobile sites plus a modules-local one is the fallback.

### 2. live-shell `DeviceBundle` seed scaffold — 3 copies

`apps/mobile/test/live-shell-support.tsx` has three seed helpers that repeat the same `verifierFor(seq, saltBase)` argon2id closure + the `DeviceBundle` tenant/store/settings/users scaffold:

- `seedDirectory` (~180-225) — one user.
- `seedTwoUsers` (~238-295) — two users, one role.
- `seedOwnerAndLockedTarget` (~312-395) — owner role + plain role + a locked attempt row (added by 186b-1).

The `verifierFor` closure is byte-identical (11 lines) across `seedTwoUsers` and `seedOwnerAndLockedTarget`; the bundle header (tenant/store/settings) is identical across all three; they differ only in the users array + rolesSnapshot. **Proposed home:** a single `seedBundle({ users, roles })` builder (+ a shared `verifierFor`) in `live-shell-support.tsx`, with the three public helpers reduced to their data. Test-fixture code, so the extraction is low-risk and stays inside the one support module.

## Acceptance

- Each mapping site and each seed helper delegates to the one shared implementation; no behavior change.
- Full mobile + modules suites stay green (the existing tests are the behavior guard — a pure refactor needs no new test, per §2.11 the guard is the unchanged suite going red if the extraction drifts).
- Grep proves the copies are gone: `error instanceof DomainError ? .*'UNEXPECTED'` resolves to one definition; the `verifierFor` closure appears once.
