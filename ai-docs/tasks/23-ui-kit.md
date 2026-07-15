# TASK 23 — ui-kit (@bolusi/ui tokens + mandatory-state components)

**Status:** in-review
**Depends on:** 01, 22

## Goal

Deliver `@bolusi/ui`: the complete, closed v0 component inventory of design-system §3 plus the token vocabulary of §1, as a buildable composite package (ESM + `.d.ts` to `dist/`, Hermes-only per 08-stack §3.3). Ships `tokens.ts` (frozen objects, closed palette/scale) and the components: Button (primary/secondary/destructive × default/pressed/disabled/busy), TextInput, PinPad (6-dot, auto-submit, error/locked), ListRow, Card, Chip incl. the canonical sync-status chips (pending/rejected, rejected-wins precedence), Banner (info/warning/danger + staleness mapping + priority stacking), Toast, EmptyState, ErrorState, UnauthorizedState (three distinct components per §3.8/§5), LoadingState (skeleton/spinner per §3.9 policy), ConfirmSheet, the whitelisted `Icon` component, and the presentational AppShell layout (§8.1 anatomy: header + SyncChip + avatar slot, banner slot, content, bottom action bar) — props-driven only; navigation wiring stays in task 24. Every component enforces the accessibility floor (§6: ≥48dp targets, contrast-validated token pairs, no color-only signaling, `accessibilityRole`/`accessibilityState`) and takes all user-visible strings as already-localized props — no `t()` calls, no literals inside the package. No styling/animation library (§7 — StyleSheet + tokens only). Includes a dev-only `Gallery` screen enumerating every component in every mandatory state, and the lint enforcement design-system §7 assigns to this surface.

## Docs to read

- `design-system.md` — ALL sections (owning doc: tokens, inventory, per-component state contracts, offline-first UI rules, a11y floor, RN constraints, shell conventions, review checklist §9).
- `03-state-machines.md` — §8 Staleness only (level names `fresh|warning|stale` are the Banner-mapping input contract; thresholds stay in that doc — do not restate) plus the §2 `Operation.syncStatus` value list (`local|synced|rejected`) for chip states.
- `07-i18n.md` — §4.1 (lint rule + scopes) and §3.1 key grammar only (chip/banner label KEYS like `sync.chip.pending` are documented contracts, but this package receives resolved strings as props — screens call `t()`).
- `08-stack-and-repo.md` — §3.3 (`@bolusi/ui` row: deps, Hermes-only, contended), §3.5/§4 build shape (composite, dist-consumed), §5.2 (custom ESLint rules + scopes).
- `testing-guide.md` — Part A invariants T-4 (assert keys/testIDs/roles, never copy) and T-5 (no snapshot tests).

## Skills

- `superpowers:test-driven-development` — always.
- `frontend-design:frontend-design` — UI task.
- `superpowers:verification-before-completion` — run the gates, read their output, before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.
- Verify current docs (Context7) before pinning RN component-test tooling and `expo-image`/`@expo/vector-icons` versions (08-stack: verify at install; no versions from training data).

## Files / modules touched

- `packages/ui/` (**contended shared package** — CLAUDE.md §4: serialize, land before dependents 24/25):
  - `packages/ui/package.json`, `tsconfig.json` (composite, ES2022, `"type": "module"`, emits to `dist/`)
  - `packages/ui/src/tokens.ts` — the ONLY file allowed styling literals
  - `packages/ui/src/components/` — `Button.tsx`, `TextInput.tsx`, `PinPad.tsx`, `ListRow.tsx`, `Card.tsx`, `Chip.tsx`, `SyncStatusChip.tsx`, `Banner.tsx`, `Toast.tsx`, `EmptyState.tsx`, `ErrorState.tsx`, `UnauthorizedState.tsx`, `LoadingState.tsx` (Skeleton + Spinner), `ConfirmSheet.tsx`, `Icon.tsx` (named-icon whitelist over `@expo/vector-icons`)
  - `packages/ui/src/shell/` — `AppShell.tsx`, `SyncChip.tsx` (header chip, 5 states per §8.1), `AvatarButton.tsx`
  - `packages/ui/src/gallery/Gallery.tsx` + a state registry (component → mandatory states) driving both Gallery and the coverage test
  - `packages/ui/src/index.ts` (public exports)
  - `packages/ui/test/` — component tests (see Acceptance)
- `tooling/eslint/` (**contended** — shared tooling; serialize):
  - new rule `bolusi/no-token-literals` implementing design-system §7 lint (a): color/size literals in `.tsx` outside `tokens.ts` are errors (scope: `packages/ui`, `apps/mobile`, `packages/modules/**/screens`)
  - extend `bolusi/no-hardcoded-strings` scope (08-stack §5.2) to include `packages/ui`
  - confirm `bolusi/boundaries` already blocks `react-native-reanimated` + styling libs (NativeWind/Tamagui/styled-components/Restyle) for these scopes; add the patterns if absent (design-system §7 lint (c))

No `apps/*`, no `packages/schemas`, no `packages/core` changes.

## Acceptance

Observable done-condition: `pnpm --filter @bolusi/ui build`, `pnpm lint`, and `pnpm --filter @bolusi/ui test` all green in CI; `Gallery` renders every inventory component in every mandatory state (coverage test below proves it mechanically — no reviewer memory required).

Tests to add (vitest; RN component render tests; per T-4 assert `testID`s / `accessibilityRole` / `accessibilityState` / label-key props — NEVER rendered copy; per T-5 zero `toMatchSnapshot`):

- **Tokens:** every exported token object is frozen (`Object.isFrozen`); `tokens.ts` exports a declared list of fg/bg pairs mirroring §1.1 "Usage" pairings (text/surface, textMuted/surface, onPrimary/primary, warning/warningBg, `#991B1B`/dangerBg, info/infoBg, success pairs, onDanger/danger, primary/surface) and a WCAG contrast computation asserts every pair ≥ 4.5:1 — `textDisabled` is the sole exemption. Adding a pair without passing contrast fails.
- **Coverage (the "story harness" gate):** a test walks the Gallery state registry and asserts every §3 inventory component declares and renders all of its mandatory states without throwing: Button ×4 states ×3 variants; TextInput default/focused/error/disabled; PinPad entry/error/locked; Chip pending/rejected; Banner info/warning/danger; Toast; EmptyState/ErrorState/UnauthorizedState; LoadingState skeleton+spinner; ConfirmSheet; SyncChip synced/pending/syncing/offline/attention. A component missing from the registry fails the test (registry is generated from the public exports, not hand-listed twice).
- **Button:** `busy` disables press (rapid double-tap fires `onPress` at most once before busy), replaces label with spinner, keeps explicit width style (width-stable); `disabled` sets `accessibilityState.disabled`; destructive and primary are separate variants (no styling override prop that could bypass the palette).
- **PinPad:** (a) auto-submit — `onComplete` fires exactly once with the 6-digit value on the 6th key press, never on the 5th, and further presses after the 6th before reset are ignored (idempotent single fire); (b) backspace removes the last digit and unfills the corresponding dot; backspace on empty entry is a no-op; (c) digits are NEVER echoed: no pressed digit appears as text or in any `accessibilityLabel`/`accessibilityValue` in the rendered tree after entry (test greps the tree for the entered digits); the entered value's only egress is the `onComplete` callback; (d) `error` state clears entry, shows message-slot text prop, dots use danger token; (e) `locked` disables every key (`accessibilityState.disabled` on all 11 keys) and renders the countdown message prop — no lockout arithmetic in the component (owned by api/02-auth, wired in task 14); (f) fixed key order 1–9, blank, 0, backspace (position assertions); keys ≥ 64dp.
- **Sync-status chips:** `syncStatus: synced` renders nothing; `local` → pending chip (testID + icon present); `rejected` → rejected chip; both present → rejected wins; rejected chip is pressable (`onPress` prop invoked) with hit area ≥ 48dp; pending chip is not alarming (no danger tokens in its styles). Invalid/unknown status value → throws or renders nothing (assert chosen behavior; never renders a wrong chip).
- **Banner mapping:** staleness `fresh` → no banner; `warning` → warning variant; `stale` → danger variant (input is the level name only — no thresholds in this package); conflict-surfaced → warning; rejected-op / device-revoked / user-deactivated inputs → danger. Danger banner exposes no dismiss affordance while its cause prop persists; warning collapses and re-expands per §3.6; info dismisses. **Priority stacking:** given multiple active banner inputs, exactly one renders, in §3.6 priority order (all 6 ranks pairwise-tested), suppressed count renders the "+N" affix and the banner is pressable.
- **LoadingState policy:** with fake timers, renders null before 300 ms and the treatment after; skeleton renders exactly 6 ghost rows whose height equals `touch.row`; no animation loop is started (no shimmer).
- **Empty/Error/Unauthorized:** three distinct exported components (identity test — Unauthorized is not EmptyState with different props); EmptyState renders its CTA Button iff `onCreate` is provided (permission decision is the screen's, per prop); ErrorState exposes retry action + error-code caption slot; UnauthorizedState exposes back action.
- **A11y floor (every interactive component):** `accessibilityRole` set; style-based min-dimension assertions — all pressables ≥ 48dp (`touch.min`), Button height 56, PinPad keys 64, ListRow ≥ 56; Chip below 48dp visual asserts compensating `hitSlop`; every status-signaling component (chips, banners, TextInput error) renders an icon or text sibling, never color alone.
- **Package hygiene tests:** `package.json` dependency list contains no styling/animation/font/icon deps beyond the 08-stack §3.3 allowance (react-native, `expo-image`, `@expo/vector-icons`); grep-gate test asserts zero `toMatchSnapshot`/`t(` occurrences in `packages/ui/src`.

SEC-\*/CHAOS-\*: **none belong to this surface** — the security-guide roll-up (OPLOG/SYNC/AUTH/DEV/MEDIA/TENANT/RT/SECRET/META) attaches to tasks 13/14/16/17/19/20/21/26/28; PinPad lockout adversarial tests (SEC-AUTH-02..05) ship with task 14, which owns the lockout logic this component only renders. The component-level adversarial floor here is the PinPad never-echo / single-egress / locked-disables-keys tests above, shipped in this task before review (CLAUDE.md §2.5).

Lint/CI gates:

- New rule `bolusi/no-token-literals` lands with rule unit tests: a fixture `.tsx` with a raw hex and a raw dp literal fails; the same values via tokens pass; `tokens.ts` itself is exempt.
- `bolusi/no-hardcoded-strings` (via `eslint-plugin-i18next` config per 07-i18n §4.1) now covers `packages/ui`; a fixture with a JSX string literal fails; the package itself lints clean — zero literal strings.
- `bolusi/boundaries` covers `react-native-reanimated` + styling-lib imports for `packages/ui` (fixture test).
- `pnpm lint`, `pnpm typecheck` (`tsc -b`), `pnpm --filter @bolusi/ui test` green on the PR; no new dependencies outside those named above (reviewer checks the lockfile diff per design-system §9).
