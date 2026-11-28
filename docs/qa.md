# QA

A UI change is done when its flow has been run, every changed screen looked at, and the layout
check is green. Run the fast lanes yourself; ask for the Android run before merging phone UI.

## Fast lanes (any machine, including cloud containers)

| What                   | Command                                                                                                      | Time |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| Phone screens, browser | `pnpm --filter @bolusi/mobile test:visual`                                                                   | ~3 m |
| One phone spec         | `pnpm --filter @bolusi/mobile exec playwright test --config e2e-web/playwright.config.ts repair -g handover` | <1 m |
| PC app, Electron       | `pnpm --filter @bolusi/desktop e2e` (Linux: `xvfb-run -a`)                                                   | ~2 m |
| PC layout only         | `pnpm --filter @bolusi/desktop exec playwright test -c e2e/playwright.config.ts layout`                      | <1 m |

Every lane builds first (`tsc -b`, then the app or web bundle), however it is started, so a run
never checks stale code.

The phone lane runs every spec twice: project `phone` and project `large-font` (system font 1.3x).
Screenshots land in `apps/mobile/e2e-web/artifacts/<project>/` and `apps/desktop/e2e/artifacts/`.
Where the installed Chromium does not match the pinned Playwright (cloud containers), set
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium`.

## The layout check

Every phone `shoot()` and every PC layout screen runs `expectCleanLayout`
(`packages/test-support/src/layout-audit.ts`). It fails the test when a screen breaks a rule of
the design guide that a machine can see:

- text cut off or ellipsized (only `ValueText` on the phone and `OverflowText` on the PC may cut,
  and only a value someone typed)
- text drawn over other text, or the page scrolling sideways
- an amount, a code (`K7Q-0012`) or a phone number split across lines
- a font size off the type ladder, text under 4.5:1 contrast, a control under its minimum size
- two filled primary buttons in view

A failure names the rule, the element's testID and its text. Fix the layout, not the check. A
state that breaks a rule on purpose passes `allow: ['rule']` to `shoot` and says why next to it.

New screens get a screenshot in a spec, so they are checked at both font sizes for free. Data in the
demos should be realistic in volume and length (20+ rows, long names) so the check sees the real
cases.

## Android and iOS

Cloud containers cannot run an emulator. Android runs on the QA VPS's emulator, driven from
Joseph's Mac over Remote Control (VPS address and rules in project memory: one emulator at a time,
lock `~/.bolusi-qa.lock`, work in `~/bolusi-qa`, no sudo, no public ports). The VPS cannot reach
GitHub, so the Mac fetches and copies a git bundle. iOS runs on the Mac's Simulator.

Drive the app with `adb` (`input tap|text`, `uiautomator dump`, `screencap`) and change the font
with `adb shell settings put system font_scale 1.3`. The emulator camera returns a black frame with
a yellow date stamp by design; photo content needs a real phone.

## Report

Commit, platforms and sizes, what was tried, screenshots of each changed state, findings marked
**blocks merge**, **fix soon** or **note**, and what was not covered.
