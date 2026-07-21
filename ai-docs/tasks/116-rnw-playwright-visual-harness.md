# TASK 116 — a react-native-web + Playwright visual harness so the screens can be SEEN and interaction-tested in a browser (the layer the test-renderer cannot cover)

**Status:** in-progress
**Priority:** MEDIUM — the frontend phase (D20 §3) started but nothing renders to pixels; the test-renderer asserts the component tree only. This makes the screens visible + screenshot-testable in a headless browser, closing the "beautiful, not confirmed" gap D17 opened.
**Depends on:** 96 (so the notes screens are in the set), 82 (media capture screens), 69 (the existing screen set)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, at the owner's request.

## Why this is the right tool (and its honest ceiling)

Playwright automates browser engines, not native apps. A React Native app's UI is native views, not a WebView, so neither Playwright's mobile-emulation nor its experimental `_android` (which drives Chrome/WebView on an AVD) can see the RN screen tree. The one thing that renders the RN screens **in this environment, with no emulator/device**, is **react-native-web** (RNW) — the `@bolusi/ui` kit uses only RNW-supported primitives (View/Text/Pressable/FlatList/TextInput/Modal, verified). RNW renders the components to real DOM; Playwright then screenshots + drives them.

**Ceiling, stated up front:** RNW is a browser *approximation*, not native — fonts, shadows, safe-area insets and gestures differ from a real 2GB Android. It does NOT replace the device gates (27a emulator, 27b physical) or the native E2E (task 117 Maestro). It is a fast visual+interaction feedback loop, complementary to those.

## Docs to read
- Context7 `/necolas/react-native-web` (rendering: `AppRegistry.registerComponent`/`runApplication` into `#root`; the `react-native$` → `react-native-web` alias; `react-dom`) and the current **Expo SDK 57 web** setup (`expo install react-native-web react-dom @expo/metro-runtime`; `expo start --web` uses Metro-web — prefer this over hand-rolled webpack). VERIFY current via Context7 before wiring.
- `apps/mobile/app.config.ts` (add `web` to `platforms`), `apps/mobile/package.json` (the web deps).
- `apps/mobile/src/bootstrap/**` — the composition root + the injected PORTS (network/clock/fs/db/crypto). This is the seam: a **web bootstrap binds in-memory FAKES** for the 36 native-module files (op-sqlite/SQLCipher, expo-camera, secure-store, quick-crypto) that don't run on web, and seeds a demo tenant + demo notes so data-backed screens render.
- `design-system.md` §5 (the four states each screen must show) — the harness screenshots each state.

## Deliverable
1. **Enable web** on `apps/mobile` (Expo web deps + `platforms` includes `web`), building via Metro-web (confirm SDK 57's supported path via Context7 — do NOT hand-roll webpack if Expo web covers it).
2. **A web bootstrap** (`apps/mobile/web/` or similar) that binds in-memory fake ports (reuse the existing port interfaces — the platform-free-core design exists exactly for this) and seeds a demo tenant/user/notes so every screen renders with realistic data WITHOUT native modules.
3. **A Playwright screenshot + interaction suite** (`@playwright/test`, its own config): navigate to each screen, drive it into each of design-system §5's four states (loading/empty/unauthorized/error) plus the happy path, and capture a screenshot per state into a committed/artifact dir. Include a few interaction assertions (tap the PIN pad, open ConfirmSheet, toggle ID/EN i18n) proving the browser-rendered screen responds.
4. A `pnpm` script (e.g. `visual` / `test:visual`) that serves the web build and runs the Playwright suite headless.

## FALSIFY (§2.11 — REPORT it)
- The suite must actually render the real screens, not a stub: break a screen's layout (e.g. remove the create-CTA gate) → a screenshot-assertion or a role/text assertion reds. Restore → green. A harness that would pass against a blank page proves nothing (T-14 — assert real content, not just "a page loaded").
- The fake ports must feed REAL screen data: seed a note titled X → it appears in the NotesList screenshot/DOM; change the seed → it changes. A harness that renders empty regardless is the vacuous-pass trap.

## Constraints / coexistence
This touches `apps/mobile/app.config.ts` + `package.json` (web deps) — coordinate so it lands cleanly after the in-flight mobile agents (96 screens, 27a harness). Do NOT alter the native build config in a way that changes the Android/iOS output (web is additive: `.web.tsx` overrides + the `platforms` addition only). Do NOT touch `@bolusi/core`/`@bolusi/schemas`/`@bolusi/ui` component internals — the harness RENDERS them, it does not change them. Screenshots are an approximation — every artifact/report says "RNW browser approximation, not device-verified" so no one mistakes it for the device lane.

## Acceptance
- `pnpm test:visual` (or equivalent) serves the web app with fake data and produces a screenshot per screen-state, headless, exit 0.
- The two falsifications above pass (break screen → assertion reds; seed change → render changes).
- `pnpm typecheck`/`pnpm lint`/`pnpm test` (native lanes) stay green — web is additive and must not regress the native build or the existing 360+ mobile tests.

## Note
The point is to make the frontend VISIBLE, not merely tested. Once this lands the orchestrator can drive it live via the Playwright browser tools and send the owner actual screenshots. It is the cheapest fidelity below a real device — pair it with task 117 (Maestro on the 27a emulator) for true native coverage.
