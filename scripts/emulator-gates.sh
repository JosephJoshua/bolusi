#!/usr/bin/env bash
# The Android emulator lane's correctness gates — task 27a's harness driver + task 117's Maestro
# native E2E. Invoked by `.github/workflows/ci.yml` (job `android-emulator`) as
# `script: bash scripts/emulator-gates.sh`, INSIDE reactivecircus/android-emulator-runner@v2 so both
# gates share the one booted AVD.
#
# WHY THIS IS A FILE AND NOT AN INLINE `script:` BLOCK (task 162). The action runs its `script:`
# input through `/usr/bin/sh`, which on ubuntu-latest is dash. Dash implements POSIX `set` and has
# no `pipefail`, so the inline version aborted on its own first line:
#     [command]/usr/bin/sh -c set -euo pipefail
#     /usr/bin/sh: 1: set: Illegal option -o pipefail
#     ##[error]The process '/usr/bin/sh' failed with exit code 2
# (CI run 29949061877, job 89021867602) — and NONE of the commands below ever ran. The fix changes
# the INTERPRETER, never the semantics: the shebang and the explicit `bash` at the call site put
# this file on a shell that has `pipefail`.
#
# FAIL-SAFE (CLAUDE.md §2.11 / §2.1): `set -euo pipefail` with NO `|| true` and NO
# `continue-on-error` anywhere is what makes a red harness OR a red Maestro flow exit non-zero and
# fail the JOB. Dropping `pipefail` to satisfy dash would turn a broken gate into a silent one —
# strictly worse than no gate. Do not weaken this line.
#
# Paths below are relative to the repository root; run it from there (ci.yml does).
set -euo pipefail
export PATH="$HOME/.maestro/bin:$PATH"
APK=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
# 27a's correctness driver — UNCHANGED command, runs first and unmasked.
pnpm harness:device --apk "$APK"
# Task 117: install the test-profile APK so Maestro's launchApp (appId com.bolusi.app)
# finds it, then drive the real native app. `maestro test .maestro/` runs only the
# top-level LIVE flow by default; .maestro/pending-119/* is skipped until task 119 wires
# the live session shell. --test-output-dir collects screenshots for the upload step.
adb install -r "$APK"
maestro test --test-output-dir=maestro-artifacts .maestro/
