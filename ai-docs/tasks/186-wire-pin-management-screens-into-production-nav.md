# TASK 186 — wire the three PIN-management screens into production navigation + the verifier-POST queue

**Status:** in-progress
**Priority:** MEDIUM — the screens exist, are unit-tested and harness-rendered, but are not reachable from the running app; a shop cannot change/reset/unlock a PIN until this lands.
**Depends on:** 138 item 1 (built the screens), 133 (session composition), 89 (sync client / online transitions)
**Blocks:** —
**SEC ids owned by THIS task:** none new (the enforcement is core's — SEC-AUTH-02/06 etc.; this is wiring).
**Filed by:** task 138 item 1 implementation, 2026-08-04.

> **SUB-SLICE A-1 — CHANGE PIN REACHABLE + LOCAL FLOW — DONE 2026-08-05.** Change PIN is now reachable end-to-end: a "Change PIN" row in a new Settings *Security* section (`core.settings.security`) → `setRoute('changePin')` → a new `changePin` member of `ShellRoute` (backs to Settings, not Home — `backTarget`; the App shell renderer gained the branch, the two invisible-miss spots the map flagged) → `<ChangePinScreen>` → `App.onChangePin` → `session.changePin` (new `AppSessionController` method) → core's `auth.changePin` over the live command runtime + a session-scoped `PinVerifierQueue`. The current PIN is verified for real (argon2id) and the new verifier applied LOCALLY at once. **Tests:** `zone.test`/`RootNavigator.test` route enumerations + a `backTarget` changePin→settings test; a SettingsScreen row→callback test; and a REAL end-to-end `test/live-shell-changepin.test.tsx` (sign in → Settings → Change PIN → drive the pad → the change reaches `done`; a wrong current PIN is refused and moves the attempt counter). **§2.11-falsified:** backTarget→home reds the back test; the row→noop reds the entry test; removing the App render branch reds the live-shell reach test. **Benign, noted (review):** an idle-lock mid-Change-PIN persists `route:'changePin'`, so the SAME user's unlock restores a FRESH Change-PIN pad (no entered-PIN state is retained; a different user gets `emptyWorkspace → home` via the owner check) — the "restore where you were" intent, not a strand. **Robustness (review):** the `finally` row-refresh is `.catch`-swallowed so a read failing after a SUCCESSFUL change can never surface that success as an error. **Fixture fix:** `seedDirectory`/`seedTwoUsers` granted only notes permissions; added `auth.pin_change` (which the real matrix grants to every role, 02-permissions §12) so the flow's permission check passes — a fixture completeness fix, not a code change.
>
> **REMAINING — A-2 (the verifier-POST drain):** the queued verifier is not yet POSTed. `session.changePin` enqueues it on the session-scoped `PinVerifierQueue`; nothing drains it, so a change is honored LOCALLY but the server (and thus other devices via bundle) never learns the new verifier — correct for a single-device shop, a disclosed gap for multi-device. A-2 writes a `PinVerifierUploadPort` fetch adapter (`POST /v1/users/:userId/pin-verifier`, device-token + `X-Acting-User`; mirror `push/transport.ts`) and drains on next online contact via the existing `onBundleRefreshed` hook (Root). **REMAINING — B:** the owner Reset + Unlock screens (permission-gated entry, directory + lockout reads, target picker).

## Why this is a separate task (not part of 138 item 1)

138 item 1 built the three screens the way this repo builds every screen — a pure `model.ts` + thin `Screen.tsx` + i18n + adversarial tests + gallery render — and stopped at the seam every one of those screens exposes: an **injected async callback** (`onChangePin` / `onResetPin` / `onClearLockout`) that runs the already-shipped core flow. They are visually verified in the harness (`pnpm --filter @bolusi/mobile test:visual`, entries `change-pin` / `reset-pin` / `clear-lockout`) and covered by 77 unit tests, but knip (task 137) correctly flags all 11 modules as unreachable from a production entry — they are **built ahead of their consumer** and snapshotted in `knip-baseline.json` (reason at `scripts/check-unused-exports.mjs`). This task is that consumer.

Reaching production is genuinely a **feature-sized integration** touching contended shared navigation + the sync lifecycle, which is why it is not crammed into a screens task (CLAUDE.md §2.5: don't rush a security surface; §4: serialize contended shared nav):

## The work

1. **Navigation reach.** `navigation/zone.ts`'s `ShellRoute` is `'home' | 'syncStatus' | 'settings'` and the shell is a pure gate, not a router (deliberately — see `zone.ts`). Decide how each screen is reached and extend the union **once** (with `backTarget` + `RootNavigator`/`Root` shell renderer + the push-router surface handled — every `ShellRoute` consumer):
   - **Change PIN** — a self-service row on the Settings screen (`auth.pin.change.title`), reached from `settings`.
   - **Reset PIN / Unlock PIN** — owner actions; decide the entry point (a Settings "manage users" area, or from the switcher). Both screens already render the §5 **Unauthorized** state for a non-owner, so a wrongly-reachable entry fails closed, but the entry should still be gated on the permission for a clean UX.

2. **Thread `PinFlowDeps` (core `pin-flows.ts`).** Build the three callbacks in `Root`/`bootstrap` from the live session: `runtime` (enrollment runtime), `db`, `crypto`, `clock`, `idSource`, `deviceId`, a `PinVerifierQueue`, and the `LockedOutEmitter`. Map the core flow's `DomainError` throws through the tested mappers the models already export (`changePinFailure`, `resetOutcome`, `clearLockoutOutcome`) — the callback rejects with the DomainError and the screen's catch maps it (already wired in the screens).

3. **Drain the verifier-POST queue on next online contact (api/02-auth §5.4).** `emitVerifierChange` enqueues a `PendingVerifier`; nothing drains it yet. Without the drain a PIN change/reset is honored **locally** (op syncs, local verifier written) but the **server's** authoritative verifier never updates, so other devices never receive the new PIN via bundle refresh (§5.2) and a bundle refresh could restore the old verifier. Hook `PinVerifierQueue.drain(uploadPort)` to the sync client's online transition (task 89). This is the sync-lifecycle half and the main reason this is not a trivial wire-up.

4. **Directory + lockout reads for the owner screens.** The owner screens take `users: PinTargetUser[]` with a caller-derived `lockedOut` flag (from task 14's `derivePinAuthState` over `pin_attempt_state`) and `actorUserId`. Wire the directory read (`users_directory`) + the per-user lockout derivation + the `canReset`/`canUnlock` permission checks (`runtime.commands.enforcementPoint.hasPermission`).

## Acceptance

- Each screen reachable from the running app for a permitted user; a non-owner reaching an owner screen sees the §5 Unauthorized state.
- A PIN change/reset drains to the server on next online contact and propagates to a second device via bundle refresh (prove with the two-device / harness round-trip).
- knip: the 11 `screens/pin/*` modules leave `knip-baseline.json` (they are now reachable) — a MASS-DISAPPEARANCE-aware re-baseline, and `scripts/check-unused-exports.mjs`'s task-186 note is removed.
- §2.11: falsify the online-drain (break the trigger, watch the server verifier stay stale, restore).
