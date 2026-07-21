# `.maestro/` — native E2E flows (task 117)

Maestro flows that drive the **real** React Native app on an Android emulator/device via
UIAutomator2 — native views, not a WebView. This is the true-native counterpart to task 116's
Playwright browser approximation: Playwright can never see RN's native views, so this suite covers
what it structurally cannot.

## What runs where

Maestro's default discovery runs **only top-level flow files** in the directory you point it at, and
**ignores subfolders**. That is the whole mechanism this suite uses to separate live from pending:

| Location                                   | Flow                                           | Status           | Run by CI? |
| ------------------------------------------ | ---------------------------------------------- | ---------------- | ---------- |
| `01-launch-enrollment.yaml`                | launch → enrollment wizard + native text entry | **LIVE now**     | **yes**    |
| `pending-119/02-pin-entry.yaml`            | switcher → PIN pad → unlock                    | pending task 119 | no         |
| `pending-119/03-shell-navigation.yaml`     | home → Sync Status → Settings                  | pending task 119 | no         |
| `pending-119/04-note-create.yaml`          | list → create → attach → save                  | pending task 119 | no         |
| `pending-119/05-archive-confirmsheet.yaml` | detail → Archive → ConfirmSheet → confirm      | pending task 119 | no         |
| `pending-119/06-i18n-toggle.yaml`          | Settings → toggle locale id ⇄ en               | pending task 119 | no         |

**Why only enrollment is live.** The app shell is a pure gate (`apps/mobile/src/navigation/zone.ts`).
A fresh, unenrolled device resolves unconditionally to the enrollment wizard. The composition root
(`apps/mobile/src/bootstrap/Root.tsx`) currently hardcodes `session={null}`, `users={null}`,
`locked={false}` and injects no `NotesRuntime`, so the switcher, PIN, shell, notes, and settings
surfaces are **not reachable in the running app yet** — task 119 wires the live session shell. The
pending flows are authored against the real screen `testID`s so that, once 119 lands, they are
promoted by moving them up to the top level (or adding a `config.yaml` with `flows: ['**']`).

## Run it locally (you need a booted AVD)

There is no emulator on the CI dev host; this is how someone WITH an Android emulator runs it.

```bash
# 1. Install the Maestro CLI (JDK required; it lands in ~/.maestro/bin).
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$HOME/.maestro/bin:$PATH"

# 2. Boot an AVD (any recent one), then build + install a test-profile APK. The CI lane builds it as:
#      BOLUSI_TEST_HARNESS=1 EXPO_PUBLIC_API_URL=http://10.0.2.2:3000 \
#        pnpm --filter @bolusi/mobile exec expo prebuild --platform android --no-install
#      ./gradlew -p apps/mobile/android assembleRelease
#    then: adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
#    (a `development`/`preview` dev-client APK also works — the harness flag only unlocks a hidden
#    runner door and does NOT change the rendered UI.)

# 3. Run the live suite (top-level flows only):
pnpm e2e:native            # == maestro test .maestro/
# or, with artifacts:
maestro test --test-output-dir=maestro-artifacts .maestro/

# Run a single flow, or the pending ones once 119 lands:
maestro test .maestro/01-launch-enrollment.yaml
maestro test --include-tags pin .maestro/pending-119/
```

`appId` for every flow is `com.bolusi.app` (the Android `applicationId`).

## CI

The Maestro run is wired into task 27a's existing `android-emulator` job in
`.github/workflows/ci.yml` — it reuses 27a's **single** emulator boot (Maestro runs inside the same
`reactivecircus/android-emulator-runner` `script`, because the AVD only exists for that step's
duration; a second runner would boot a second AVD). The step installs the CLI, `adb install`s the
test-profile APK, runs `maestro test .maestro/`, and uploads screenshots/artifacts. There is **no**
`continue-on-error` and **no** `|| true` on the Maestro run: a red flow exits non-zero and fails the
job (CLAUDE.md §2.11). Because the `android-emulator` job is scheduled / `workflow_dispatch` (not
per-PR), a first-run failure is a red scheduled job, never a false green on a PR.

**Honesty (CLAUDE.md §2.1):** there is no Android emulator on the dev host, so `maestro test` on the
emulator has **not** been run here — it runs in CI. What was verified on the host: the flow YAML and
the CI YAML parse, and the CI step's fail-safe (a non-zero Maestro exit propagates through the
wrapper). No green emulator run is implied by anything in this repo until CI produces one.
