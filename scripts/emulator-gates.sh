#!/usr/bin/env bash
# The Android emulator lane's correctness gates — task 27a's harness driver + task 117's Maestro
# native E2E. Invoked by `.github/workflows/ci.yml` (job `android-emulator`) as
# `script: bash scripts/emulator-gates.sh`, INSIDE reactivecircus/android-emulator-runner@v2 so both
# gates share the one booted AVD.
#
# WHY THIS IS A FILE AND NOT AN INLINE `script:` BLOCK (task 162). The action does NOT run `script:`
# as a shell script. Its `src/script-parser.ts` splits the input per LINE, discarding `#`-comment and
# blank lines, and `src/main.ts` then runs each surviving line as its OWN `sh -c <line>` — and
# /usr/bin/sh is dash on ubuntu-latest. The run log shows exactly that: only line 1 reached a shell.
#     [command]/usr/bin/sh -c set -euo pipefail
#     /usr/bin/sh: 1: set: Illegal option -o pipefail
#     ##[error]The process '/usr/bin/sh' failed with exit code 2
# (CI run 29949061877, job 89021867602) — the step went red having run NONE of the gates below.
#
# So the inline form was broken FOUR ways, and a `pipefail`-capable shell would have fixed only one:
# dash rejects `pipefail`; `export PATH=` never reached the `maestro` line; `APK=` never reached
# `pnpm harness:device` or `adb` (both would have run with `--apk ''`); and `set -e` governed no
# command at all, because every command was a separate shell. The `#` comments were being stripped
# by the PARSER, not by a shell. What a file changes is therefore the PROCESS MODEL, not merely the
# interpreter: N shells collapse into ONE bash, where `set -euo pipefail`, `export` and `APK=` all
# actually take effect. Do not restore the inline form on the theory that it shares one shell.
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
# Task 117 + 201-B: install the test-profile APK so Maestro's launchApp (appId com.bolusi.app)
# finds it, then drive the real native app against a LIVE lane server. The lane driver
# (scripts/harness-lane-e2e.mjs) boots @bolusi/server on the 127.0.0.1:3000 loopback — the guest
# reaches it via the 10.0.2.2 NAT alias, no `adb reverse` — provisions a real enrolled+PIN owner,
# then waits for its ready marker. FAIL CLOSED (§2.11): no marker ⇒ the driver exits non-zero
# BEFORE running Maestro, so a lane can never "pass" against a dead socket. It then runs
# `maestro test --test-output-dir=maestro-artifacts .maestro/` — all six now-live top-level flows
# (enrollment → PIN → shell → notes → archive → i18n) — and propagates Maestro's exit code, so a
# red flow reds the job. The driver imports the compiled harness barrel, so ci.yml's `tsc -b` must
# have run first (it does). --test-output-dir collects screenshots for the upload step.
adb install -r "$APK"
node scripts/harness-lane-e2e.mjs
