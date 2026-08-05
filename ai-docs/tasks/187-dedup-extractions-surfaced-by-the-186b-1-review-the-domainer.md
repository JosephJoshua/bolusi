# TASK 187 — dedup extractions surfaced by the 186b-1 review: the DomainError->code:'UNEXPECTED' mapping (4 copies) and the live-shell DeviceBundle seed scaffold (3 copies)

**Status:** todo
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the task 186b-1 review-wave (duplication lens), 2026-08-05; extended by the 186b-2 review (legs 3–4).

> **ALL FOUR LEGS DONE — 2026-08-05.** (1) `errorCodeOrUnexpected(error)` in `@bolusi/core` (`errors/domain-error.ts`) adopted at all 4 sites (`modules/notes/screens/runtime.tsx`, mobile `CaptureHost.tsx`, `session.ts`, `App.tsx`), the two local `codeOf`/`errorCode` helpers deleted and their now-sole `DomainError` imports dropped; a unit test covers it (DomainError→code, any-throwable→UNEXPECTED). (2) `seedBundle`/`verifierFor`/`activeUser`/`storeRole` in `live-shell-support.tsx` collapse the 3 seed helpers to their data. (3) `runPinFlow(method, affected, run)` in `session.ts` collapses `changePin`/`clearLockout`/`resetPin` (the guard + the shared ctx literal + the finally live once). (4) `useLatestCallback` hook (`apps/mobile/src/hooks/`) replaces the 3 ref-stable-callback copies in `App.tsx`. **All behaviour-preserving:** core 1163, mobile 817, modules 58, lint + typecheck green. **§2.11-falsified each shared helper:** `errorCodeOrUnexpected`→always-UNEXPECTED reds the unit test; `useLatestCallback`→return-fn reds `app-unlock-load` (`expected 1, got 3`); `runPinFlow`→swallow-the-error reds the wrong-current-PIN changePin test (it reached `done`); `activeUser`→`status:'deactivated'` reds the live-shell sign-in (the user vanishes from the switcher). **knip:** `errorCodeOrUnexpected` was baselined (denominator 138→139) — it is used ONLY cross-package (mobile + modules), and `@bolusi/core` resolves to `dist`, so knip cannot see the edge; it joins the 46 existing core cross-package-only exports in the baseline (`changePin`, `resetPin`, `listSwitcherUsers`, … — the same class), NOT a dead export. The resetOutcome NIT (below) was left as noted.

## Goal

Four small, independently-shippable extractions the 186b-1 and 186b-2 reviews confirmed (rule-of-three, CLAUDE.md §2.8). None was a merge blocker — each slice added the copy that tripped the threshold; all are behavior-preserving refactors whose §2.11 guard is the unchanged test suite.

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

### 3. session.ts PIN-flow wrapper — 3 near-identical copies (from the 186b-2 review)

`AppSessionController`'s three PIN-flow methods — `changePin`, `clearLockout`, `resetPin` (`apps/mobile/src/bootstrap/session.ts`) — share a ~22-line skeleton: the `manager.current === null` guard (identical `throw new Error('<method> requires an open session …')`), a `try { await <flow>(ctx, args) } finally { await loadRow(<id>).catch(() => undefined); emit(); }`, and — most conspicuously — the **10-line `ctx` literal `{ runtime: commands, db, crypto: deps.crypto, clock: deps.clock, idSource: deps.idSource, deviceId: device.deviceId, queue: verifierQueue, emitter: lockedOut }` appears verbatim 3×**. Only 4 lines vary: the method name in the throw, the `*Flow` callee, the flow-args object, and which userId `loadRow` re-reads. **Proposed home:** a private `runPinFlow(method, affected, run)` in session.ts owning the guard + the shared ctx literal + the try/finally; the three methods reduce to one line each. Behaviour-preserving; the unchanged core 1163 / mobile 817 suites are the §2.11 guard. (The permission check was already extracted this way in 186b-2 — `actingUserHolds(permissionId)`; this is the next copy of the same discipline.)

### 4. App.tsx ref-stable-callback pattern — 3 copies → a `useLatestCallback` hook (from the 186b-2 review)

The `const XRef = useRef(props.X); XRef.current = props.X; const wrap = useCallback((...a) => XRef.current(...a), [])` pattern (turn a fresh-arrow prop into a stable-identity latest-calling wrapper — the 186b-1 review fix) now appears at 3 callback sites in `apps/mobile/App.tsx`: `listPinTargetsRef→loadPinTargets`, `onClearLockoutRef→clearLockout`, `onResetPinRef→resetPin`. The underlying 2-line latest-ref idiom is at 5 sites (also `workspaceRef`, `userIdRef`). **Proposed home:** `apps/mobile/src/hooks/useLatestCallback.ts` — `function useLatestCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R`. `clearLockout`/`resetPin` become one-liners; `loadPinTargets` builds on it. Centralizes the subtlety the three comments each re-explain. Behaviour-preserving; `test/app-unlock-load.test.tsx` (fires-once-per-entry) is the §2.11 guard.

_(A NIT the 186b-2 review also flagged, not worth its own leg: `reset-pin.model.ts`'s `resetOutcome` maps a PLAIN `PERMISSION_DENIED` to the generic UNEXPECTED panel rather than the denial copy — but that path is unreachable via the UI, which gates the Reset screen on `canReset`, so only the §6.6 `restriction_violated` denial actually reaches it. Fix opportunistically if this model is touched.)_

## Acceptance

- Each mapping site and each seed helper delegates to the one shared implementation; no behavior change.
- Full mobile + modules suites stay green (the existing tests are the behavior guard — a pure refactor needs no new test, per §2.11 the guard is the unchanged suite going red if the extraction drifts).
- Grep proves the copies are gone: `error instanceof DomainError ? .*'UNEXPECTED'` resolves to one definition; the `verifierFor` closure appears once.
