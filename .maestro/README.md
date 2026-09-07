# `.maestro/` — native E2E flows (task 117, promoted to the live lane by task 201-B)

Maestro flows that drive the **real** React Native app on an Android emulator/device via
UIAutomator2 — native views, not a WebView. This is the true-native counterpart to task 116's
Playwright browser approximation: Playwright can never see RN's native views, so this suite covers
what it structurally cannot.

## What runs where

Maestro's default discovery runs **only top-level flow files** in the directory you point it at, and
**ignores subfolders**. This suite uses that in two ways: every journey is a top-level flow (so it
runs), and the shared unlock precondition lives in `subflows/` (so it does NOT run on its own — it is
pulled in with `runFlow: subflows/unlock.yaml`).

| Flow                           | Journey                                          | Runs on the lane? |
| ------------------------------ | ------------------------------------------------ | ----------------- |
| `01-launch-enrollment.yaml`    | launch → enrollment wizard + native text entry   | **yes**           |
| `02-pin-entry.yaml`            | switcher → PIN pad → unlock                      | **yes**           |
| `03-shell-navigation.yaml`     | notes → Sync Status → Settings                   | **yes**           |
| `04-note-create.yaml`          | list → create → fill → (attach) → save           | **yes**           |
| `05-archive-confirmsheet.yaml` | detail → Archive → ConfirmSheet → confirm        | **yes**           |
| `06-i18n-toggle.yaml`          | Settings → toggle locale id ⇄ en                 | **yes**           |
| `subflows/unlock.yaml`         | switcher → PIN → notes.list (a `runFlow` helper) | no (subflow)      |

**Flow order is load-bearing.** Maestro runs top-level flows alphabetically, and only `01` does
`launchApp: clearState: true`. So `01` enrolls the device against the lane, and `02`–`06` each cold
-relaunch into that inherited enrolled state (a cold launch of an enrolled device with no open session
resolves to the switcher — `apps/mobile/src/navigation/zone.ts`). `04` creates the note that `05`
then archives; because neither clears state, the write persists across the relaunch between them.

## Why every flow is now reachable (it wasn't before)

Two things had to land for the switcher / PIN / notes / settings surfaces to exist in the running app:

1. **A live session shell (task 119).** `apps/mobile/src/bootstrap/Root.tsx` now builds a session-scoped
   `NotesRuntime` after enrollment + PIN (it previously hardcoded `session={null}` and injected no
   runtime), so the home surface renders the notes module (`notes.list`) rather than the empty shell.
2. **A real server to enroll against (task 201-B).** The flows drive a genuine enrollment, which needs
   a backend that accepts the login and mints real control-session + device tokens. The **lane driver**
   (`scripts/harness-lane-e2e.mjs`) boots `@bolusi/server` (Hono on PGlite) on the `127.0.0.1:3000`
   loopback and provisions a deterministic owner the flows type verbatim:
   - login `gudang-selatan` + one-time password `harness-otp-password-201b` (`LANE_OWNER_LOGIN` /
     `LANE_OTP`, `packages/harness/src/harness-provision.ts`);
   - a single store `Toko Utama` (the one `enroll-store-<id>` row);
   - PIN `314159` (`LANE_PIN`), seeded as a real verifier so it travels in the enroll bundle and
     actually unlocks the pad.

   The guest app reaches the server through the emulator's **`10.0.2.2` NAT alias** (the alias for the
   host's IPv4 `127.0.0.1`) — the APK is built with `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000`, so
   there is **no `adb reverse`**. The lane server mints real tokens, so it binds **loopback only**
   (`assertLaneLoopbackBind`, §2.5) — it must never listen on the LAN.

**Fail-closed (§2.11).** The driver waits for the server's one ready-marker line before running
Maestro. No marker ⇒ the server never booted/bound/provisioned ⇒ the driver prints its stderr and
exits non-zero **before** spawning Maestro. A lane that "passed" because the server was down would be a
green no-op — worse than no gate — so this path is closed by construction.

## Run it locally (you need a booted AVD)

There is no emulator on the CI dev host; this is how someone WITH an Android emulator runs it.

```bash
# 1. Install the Maestro CLI (JDK required; it lands in ~/.maestro/bin).
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$HOME/.maestro/bin:$PATH"

# 2. Boot an AVD, then build + install the test-profile APK pointed at the lane's NAT alias:
#      BOLUSI_TEST_HARNESS=1 EXPO_PUBLIC_API_URL=http://10.0.2.2:3000 \
#        pnpm --filter @bolusi/mobile exec expo prebuild --platform android --no-install
#      ./gradlew -p apps/mobile/android assembleRelease
#      adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
#    (BOLUSI_TEST_HARNESS only unlocks a hidden runner door; it does NOT change the rendered UI.)

# 3. Build the harness barrel (the driver imports packages/harness/dist), then run the whole suite
#    against a freshly-booted lane server. The driver boots the server, provisions the owner, runs
#    every top-level flow, and tears the server down:
npx tsc -b
pnpm e2e:native            # == node scripts/harness-lane-e2e.mjs

# Run a single flow by hand (needs the lane server up separately, `pnpm harness:serve-lane`):
maestro test .maestro/03-shell-navigation.yaml
maestro test --include-tags pin .maestro/
```

`appId` for every flow is `com.bolusi.app` (the Android `applicationId`).

## CI

The suite runs inside task 27a's existing `android-emulator` job in `.github/workflows/ci.yml`
(`script: bash scripts/emulator-gates.sh`), reusing 27a's **single** emulator boot — the AVD only
exists for that step's duration, so a second runner would boot a second AVD. `emulator-gates.sh`
`adb install`s the APK, then runs the lane driver (`node scripts/harness-lane-e2e.mjs`), which boots
the loopback lane, provisions the owner, and runs `maestro test --test-output-dir=maestro-artifacts
.maestro/`; screenshots/artifacts are uploaded afterward. There is **no** `continue-on-error` and
**no** `|| true` on the run: a red flow — or a lane server that never signals ready — exits non-zero
and fails the job (CLAUDE.md §2.11). Because `android-emulator` is scheduled / `workflow_dispatch`
(not per-PR), a first-run failure is a red scheduled job, never a false green on a PR.

**Honesty (CLAUDE.md §2.1):** there is no Android emulator on the dev host, so this suite has **not**
been run on an emulator here — it runs in CI. What was verified on the host: every flow's YAML and the
CI YAML parse, the lane driver's fail-closed behaviour and exit-code propagation (a child-process host
test drives it against a stub Maestro that exits 0/1), and the loopback-bind assertion. No green
emulator run is implied by anything in this repo until a dispatched `android-emulator` run produces
one — read that run's own log, not the badge.
