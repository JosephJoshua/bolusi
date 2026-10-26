# QA

A UI change is not done until an agent has run the real app, used the changed flow, and looked at
screenshots. Every UI task gets both:

- **Automated tests** for the behavior: Vitest, plus a Maestro flow or Playwright spec for the
  journey where it matters. They run in CI.
- **Interactive QA**: the agent drives the running app step by step, looks at each screen, tries the
  exceptions (offline, wrong input, back, app killed mid-save, both languages), and writes a report.

## Where it runs

| Client                      | Interactive QA                                   | Where                                      |
| --------------------------- | ------------------------------------------------ | ------------------------------------------ |
| Mobile (Expo) Android + iOS | Real release build on the emulator and Simulator | Joseph's Mac, through the QA runner thread |
| Mobile screens, quick look  | react-native-web harness with in-memory fakes    | Any cloud container                        |
| Desktop (Electron, planned) | Playwright driving the Electron app              | Any cloud container                        |
| Web (planned)               | Playwright in Chromium                           | Any cloud container                        |

The web harness is a browser approximation with fake data. It is good for layout and copy, but it
does not count as QA of sync, offline storage, crypto or native behavior. Mobile UI tasks still need
the Mac run.

## Mobile on the Mac

Cloud containers cannot run an emulator or Simulator (checked 2026-10-26): they have no `/dev/kvm`
or CPU virtualization (the kernel reports nested KVM is not enabled for them), no binder for
container Android, and `dl.google.com` is blocked, so the emulator and system images cannot be
downloaded either. Threads ask the QA runner thread instead, which starts a Remote Control session on Joseph's Mac. The runner works through requests one at a time and
builds once per commit. Use a separate git worktree on the Mac so Joseph's own checkout is untouched.

Needs: Apple Silicon Mac with Xcode, Android Studio (SDK and its bundled JDK), CocoaPods, Node 22,
pnpm, and Maestro (`curl -Ls "https://get.maestro.mobile.dev" | bash`).

```sh
pnpm install --frozen-lockfile
pnpm qa:mobile up android       # lane server + headless emulator + fresh release build, clean install
pnpm qa:mobile shot android 01-intake-empty
pnpm qa:mobile down             # stop the server, emulator and Simulator
pnpm qa:mobile up ios           # same for the iOS Simulator
```

`up` starts `scripts/harness-serve-lane.mjs` on `127.0.0.1:3000` (PGlite, empty every start) and
prints the enrollment login, one-time password and PIN for the provisioned owner. Pass `--no-build`
to reuse the last build. Screenshots land in `qa-artifacts/`.

Drive the app with a mobile MCP server (tap, type, swipe, read the screen) or with small Maestro
flows (`maestro test <flow>.yaml`, `maestro hierarchy`). Look at every screenshot before deciding the
next step. Run Android and iOS one after the other to keep memory low. For offline: on Android use
`adb shell cmd connectivity airplane-mode enable`; on iOS stop the lane server, since the Simulator
shares the Mac's network.

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
