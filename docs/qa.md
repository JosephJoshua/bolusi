# QA

A UI change is not done until an agent has run the real app, used the changed flow, and looked at
screenshots. Every UI task gets both:

- **Automated tests** for the behavior: Vitest, plus a Maestro flow or Playwright spec for the
  journey where it matters. They run in CI.
- **Interactive QA**: the agent drives the running app step by step, looks at each screen, tries the
  exceptions (offline, wrong input, back, app killed mid-save, both languages), and writes a report.

## Where it runs

| Client                      | Interactive QA                                | Where                             |
| --------------------------- | --------------------------------------------- | --------------------------------- |
| Mobile (Expo) Android       | Real release build on a headless emulator     | QA VPS, via SSH from Joseph's Mac |
| Mobile (Expo) iOS           | Real release build on the iOS Simulator       | Joseph's Mac                      |
| Mobile screens, quick look  | react-native-web harness with in-memory fakes | Any cloud container               |
| Desktop (Electron, planned) | Playwright driving the Electron app           | Any cloud container               |
| Web (planned)               | Playwright in Chromium                        | Any cloud container               |

The web harness is a browser approximation with fake data. It is good for layout and copy, but it
does not count as QA of sync, offline storage, crypto or native behavior. Mobile UI tasks still need
a native run.

## Native mobile QA

Cloud containers cannot run an emulator (checked 2026-10-26): no `/dev/kvm` or CPU virtualization,
no binder for container Android, and their proxy only carries HTTPS to hostnames, so they cannot SSH
to the VPS either. Threads ask the QA runner thread ("Design automated and exploratory QA"). It
starts a Remote Control session on Joseph's Mac, which runs iOS locally and SSHes to the QA VPS
(address in project memory, using Joseph's key) for Android. The runner takes one request at a time and builds
once per commit.

**QA VPS:** bare-metal Debian 13, 96 threads, 251 GB RAM, KVM. It is shared with other services
(about 5 load average, many ports in use), so: one emulator at a time (the script takes a lock in
`~/.bolusi-qa.lock`), capped at 4 cores and 4 GB, Gradle at 8 workers, and nothing listening
publicly. The lane server binds `127.0.0.1:3000`. Work in `~/bolusi-qa` and never use sudo.
joseph's `~/.npmrc` points pnpm at an unwritable store, so prefix pnpm commands there with
`npm_config_store_dir=$HOME/.local/share/pnpm/store`. A run takes about 5 minutes the first time
(3.5 minute Gradle build) and 2 minutes after; the emulator uses about 6 GB and 4 cores.

**Mac:** used for iOS only, since its disk is nearly full. Check free space first: an iOS build
needs about 12 GB.

Tools: Node 22, pnpm, a JDK (17 or newer), the Android SDK command-line tools (VPS) or Xcode and
CocoaPods (Mac), and Maestro.

```sh
pnpm install --frozen-lockfile
pnpm qa:mobile up android       # lock + lane server + headless emulator + fresh release build
pnpm qa:mobile shot android 01-intake-empty
pnpm qa:mobile down             # stop everything and release the lock
pnpm qa:mobile up ios           # Mac only
```

`up` starts `scripts/harness-serve-lane.mjs` on `127.0.0.1:3000` (PGlite, empty every start) and
prints the enrollment login, one-time password and PIN for the provisioned owner. The app talks to
it through `scripts/qa-proxy.mjs` on `127.0.0.1:3091`, which writes one line per request (method,
path, status, time, sizes; no bodies or tokens) to `.qa/requests.log`. Release builds have no JS logs
and no `run-as`, so that log is how to tell whether a sync or upload was sent. Pass `--no-build`
to reuse the last build. Screenshots land in `qa-artifacts/`. Always finish with `down`; if `up`
fails, `down` also clears the lock.

Drive the app with `adb` (`shell input tap|text`, `exec-out uiautomator dump /dev/tty`) or small
Maestro flows (`maestro test <flow>.yaml`, `maestro hierarchy`). Look at every screenshot before
deciding the next step. For offline: on Android use `adb shell cmd connectivity airplane-mode
enable`; on iOS stop the lane server, since the Simulator shares the Mac's network.

On an emulator, expo-camera returns a black frame with a yellow date stamp instead of a real photo,
by design. A photo flow passes on the emulator when that stamped frame shows everywhere (review,
thumbnails, ticket); photo content can only be checked on a physical phone.

## Web harness in a cloud container

```sh
pnpm --filter @bolusi/mobile build:web
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium \
  pnpm --filter @bolusi/mobile exec playwright test --config e2e-web/playwright.config.ts
```

Screenshots land in `apps/mobile/e2e-web/artifacts/`. For interactive checks, serve `apps/mobile/dist`
with `e2e-web/static-server.mjs` and drive it with a short Playwright script at a 390x844 viewport.
`PLAYWRIGHT_CHROMIUM_PATH` is only needed where the installed Chromium does not match the pinned
Playwright.

## Report

Post on the PR and attach the screenshots in the thread:

- What was tested: commit, platforms, and the scenarios tried.
- Screenshots of each important state, in Indonesian, plus English where copy changed.
- Findings, each marked **blocks merge**, **fix soon** or **note**.
- What was not covered.
