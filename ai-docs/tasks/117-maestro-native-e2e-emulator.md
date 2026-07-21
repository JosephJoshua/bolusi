# TASK 117 — a Maestro native E2E flow wired into 27a's Android-emulator CI lane, so the REAL React Native app (not a browser approximation) gets driven

**Status:** in-progress
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
