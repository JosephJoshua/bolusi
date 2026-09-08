# TASK 117 — a Maestro native E2E flow wired into 27a's Android-emulator CI lane, so the REAL React Native app (not a browser approximation) gets driven

**Priority:** MEDIUM — this is the true-native counterpart to task 116's browser approximation. It drives the actual RN app on a real Android emulator via UIAutomator2 (what Playwright cannot do — RN screens are native views, not a WebView).
**Depends on:** 27a (the Android-emulator CI lane must exist first), 24, 96
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, at the owner's request.

## Why Maestro (not Playwright, not Appium)

Playwright drives browsers/WebViews; a React Native app's UI is native Android views, so Playwright can never see it. The native-driving family is Appium / Maestro / WebDriverIO — all need a running emulator/device. **Maestro** is chosen over Appium: declarative YAML flows, first-class RN support, and far less setup — it fits beside 27a's correctness gates with the least ceremony. **No paid cloud**: run the OSS CLI against the same `reactivecircus/android-emulator-runner` AVD 27a already stands up, not Maestro Cloud (which needs an API key).

## Docs to read
- Context7 `/mobile-dev-inc/maestro-docs` — flow YAML (`appId`, `launchApp`, `tapOn`, `assertVisible`, `inputText`, `takeScreenshot`), CLI install (`curl -Ls "https://get.maestro.mobile.dev" | bash`), and `maestro test flow.yaml` against a running emulator. VERIFY current via Context7 before wiring.
- `ai-docs/tasks/27-device-gates.md` + whatever 27a landed for the emulator CI job (`.github/workflows/ci.yml`) — this task ADDS a Maestro step to that lane; it does not create a second emulator boot.
- `apps/mobile` navigation + the enrollment/PIN/notes flows the smoke covers.
- `08-stack-and-repo.md` §5.5/§5.6 (the `test`/dev-client build profile the emulator runs).

## Deliverable
1. A small suite of Maestro flows (`.maestro/` YAML) covering the core user journeys on the real app: enrollment/PIN entry, create a note, attach a photo (or its stub on emulator), archive-via-ConfirmSheet, i18n toggle — with `assertVisible` checks and `takeScreenshot` at key steps.
2. Wire a **Maestro step into 27a's existing emulator CI job**: install the CLI, build/install the dev-client (or `test`-profile) APK on the already-booted AVD, `maestro test .maestro/`, upload screenshots as artifacts, fail the job non-zero on any flow failure.
3. A committed README/short doc on running it locally (`maestro test .maestro/` against a local AVD) for whoever has an emulator.

## FALSIFY (§2.11 — REPORT it; runs on the emulator, so likely CI-observed)
- A flow must fail when the app is wrong: point an `assertVisible` at a label the screen does NOT show → the flow reds. Restore → green. (Do this locally if an emulator is available, else make it a CI-observed falsification and say so — never claim a green emulator run that did not happen; §2.1/T-14d.)
- The CI step must fail the job on a red flow (not swallow it) — assert the step's exit propagates.

## Constraints / coexistence
Depends on 27a's lane landing — do NOT start until `.github/workflows/ci.yml` has the emulator job (else there is nothing to attach to). This is CI/emulator work: most of it is verified when CI runs the emulator, not on this host (no AVD here). Be explicit about what ran in CI vs what was only typechecked/linted locally. Do NOT duplicate 27a's emulator boot — reuse it.

## Acceptance
- Maestro flows exist and are wired into 27a's emulator CI job (install → APK → `maestro test` → artifacts → non-zero on failure).
- `pnpm lint`/`pnpm typecheck` green (the YAML/scripts don't break the build).
- The falsification is reported (locally if an AVD exists, else recorded as CI-observed with the reason).

## Note
Complements task 116: 116 gives fast browser-approximation screenshots in any environment; 117 gives true native rendering + gesture behaviour, but only where an emulator runs (27a's CI lane, or a device). Together they cover visual iteration AND native fidelity. Stays `blocked` until 27a lands the emulator lane.

## Current state (2026-09-06) — 1/6 flows live, 5 blocked on task 201

Delivered and proven on the emulator lane: the native-E2E harness itself (install Maestro → `adb install` the test APK → `maestro test .maestro/` → artifacts → non-zero on a red flow, no `|| true`) and the one serverlessly-reachable journey, `01-launch-enrollment` — `[Passed] (22s)`, `1/1 Flow Passed`, on run 34036548031.

The other 5 authored flows (`.maestro/pending-119/02..06`: pin-entry, shell-nav, note-create, archive-ConfirmSheet, i18n-toggle) remain parked and are **not** promotable yet. Their `.maestro/README.md` promotion plan assumed task 119 would make the switcher/PIN/shell reachable on the lane. Ground-truth check on 2026-09-06: **119 is `done` but delivered the composition-root wiring** (Root constructs a session-scoped `NotesRuntime` *after* enrollment+PIN unlock), **not** an emulator seeding harness. The lane runs no server and has no enrolled-state producer, so promoting the pending flows today reds them on the first `assertVisible: switcher-screen`.

The missing producer is filed as **task 201** (an enrollment-seed / device-fixture seam, or standing up `@bolusi/server` on the lane; option A is a §2.5 security surface). 117 is `blocked` on 201. Do **not** flip 117 `done` while 5/6 of its authored suite cannot run — and do not silently shrink this task's Acceptance to launch-only; that re-scope is the owner's call (§4) and is offered as the alternative disposition in task 201.

## 201-B emulator run findings (2026-09-08) — seam proven; 03–06 fail downstream of the seam

Task 201 (Option B — `@bolusi/server` on the lane) promoted `02..06` to top-level `.maestro/` and ran them on the android-emulator lane. Artifacts read directly (§2.1); each flow traced to its producer before attribution (§2.11):

- **02-pin-entry — PASSES.** enroll → cold relaunch → `switcher-screen` → PIN → `notes.list`. This is the seam's proof: the enrollment-seed producer delivers the enrolled+unlocked app. 03/04/05 also reach `notes.list` via `subflows/unlock.yaml` (four consecutive enrolled-state cycles), then fail on post-`notes.list` steps.
- **03-shell-navigation — fails at `assertVisible: sync-status-screen` after `tapOn: ui.syncChip`.** The wiring EXISTS (App.tsx: `onPress={openSyncStatus}` / `setRoute('syncStatus')` → renders `<SyncStatusScreen testID="sync-status-screen">`); on-device the chip tap does not reach the screen. Root cause is in the 119 shell-nav layer / chip press-target — NOT the seam and NOT a missing feature. (Corrects an earlier "zero nav callers" mis-reading; the caller is App.tsx.)
- **04-note-create — fails at `tapOn: notes.list.create` (empty device).** Verified flow-authoring bug: on an EMPTY list the create affordance is `ui.emptyState.cta`; `notes.list.create` (the bottom-action button) renders only once rows exist (contract in `apps/mobile/test/live-shell-support.tsx:663`). App is correct; the flow taps the wrong testID for the empty precondition. Fix: tap `ui.emptyState.cta` on the empty device (or give the flow a populated precondition).
- **05-archive-confirmsheet — fails at `tapOn: notes.list.row..*` (no rows).** Cascades from 04: the flow's own comment states its note "is the one 04 created". 04 fails → no note → the row regex matches nothing. Fix 04 (and the inter-flow ordering assumption) and 05 can find the row.
- **06-i18n-toggle — fails inside `subflows/unlock.yaml` at `assertVisible: switcher-screen` (device on `enrollment-screen`).** The flow does NOT `clearState`; the launch logcat shows no `startSessionIfEnrolled` (app saw no enrolled device) and no wipe/revoke/lockout marker. Enrolled state was present for 02–05 and absent for 06 only — a flow-sequence / maestro-state effect (entangled with the preceding failed 04/05), NOT a seam-producer defect (the producer works deterministically 4×). Needs 117-level investigation once 04/05 are fixed.

Net: the 201 seam (the missing producer) is delivered and proven (02 green). The four remaining failures are 117 flow-authoring (04, 05) + a 119 shell-nav gap (03) + flow-suite state sequencing (06) — all outside the enrollment-seed seam's scope (201's fixture is enrolled-state only: no content, no nav wiring, no notes-module testIDs). Meeting 117's full 5-flow Acceptance requires this 117/119 work; that it cannot be met by the seam alone is the re-scope the owner adjudicates on task 201 (§4).
