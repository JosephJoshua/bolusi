# TASK 205 — ConfirmSheet's Cancel/Confirm can render UNDER the Android nav bar (no bottom inset on the overlay)

**Priority:** MEDIUM-HIGH — this is the destructive-action gate (archive/delete note confirmation, D23 draft-loss ConfirmSheet). On a device with a 48dp on-screen nav bar the SAFE action, deliberately placed at the bottom thumb-resting zone, is the one most likely to be occluded.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the QA sweep of the 201-B emulator surface, 2026-09-08 (CLAUDE.md §2.7).

## The finding (citations verified at the producer, HEAD 17868eb)

`packages/ui/src/components/ConfirmSheet.tsx` is a plain absolute overlay, mounted by its owner rather than via RN `Modal` (comment at `:12`):

- `:36` `root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' }` — the overlay covers the whole window and pins the sheet to the bottom edge.
- `:47` `sheet:` … `:51` `padding: space.lg` — the sheet has ONLY a uniform `space.lg` pad. No bottom safe-area / nav-bar inset.
- `:9-10` the component intentionally puts the SAFE action at the bottom ("the thumb's resting position … the position a misfire is most likely to hit. Do not 'fix' this to match platform convention").

The app's Android nav-bar inset lives one layer up and does NOT reach the sheet:

- `apps/mobile/App.tsx:964` `const NAV_BAR_INSET = Platform.OS === 'android' ? 48 : 0;`
- `App.tsx:971` `shell: { flex: 1, paddingTop: STATUS_BAR_INSET, paddingBottom: NAV_BAR_INSET }` — the 48dp bottom inset is applied ONLY to `styles.shell`.
- The shell is the `<View testID="bolusi-app-shell" style={styles.shell}>` at `App.tsx:596/626`. ConfirmSheet is an absolute overlay drawn OUTSIDE that view's flow, so it never inherits `paddingBottom: NAV_BAR_INSET`.

Net: under edge-to-edge (the app draws under the system bars, `App.tsx:938-962`), the sheet's bottom `space.lg` band overlaps the 48dp nav bar. The Cancel button (`ConfirmSheet.tsx:56` `cancel: { marginTop: space.md }`, rendered last = lowest) and the Confirm button sit in that band. On a 3-button or gesture nav bar the tap target of the bottom action is partly or fully behind the nav bar.

Why the emulator lane did not catch it: Maestro `tapOn` hits a view by its layout bounds, not by what is visually on top, so `05-archive-confirmsheet` can tap Confirm even when a real user's finger would land on the nav bar. A green flow does not disprove the visual/touch-occlusion defect on real hardware (§2.1 — the artifact proves the flow ran, not that the control is reachable by a human).

## Fix direction (owner-facing — this is the contended @bolusi/ui design system, §4)

Give the sheet a bottom inset equal to the platform nav-bar height so its actions clear the nav bar. Options, in order of preference:
1. Thread the same `NAV_BAR_INSET` the shell uses into the sheet as `paddingBottom` (or `marginBottom` on `sheet`), so there is ONE inset source. `App.tsx:955-963` already documents why `currentHeight` has no bottom twin and 48dp is a hand-measured constant — keep that the single home and pass it down; do NOT re-derive a second constant in the ui package.
2. If the ui package must stay app-agnostic, accept an optional `bottomInset` prop (default 0) and have `App` pass `NAV_BAR_INSET`. Keeps `@bolusi/ui` free of `Platform`.

Do NOT reach for `react-native-safe-area-context` — `App.tsx:938` records it is deliberately not a v0 dependency.

## Acceptance
- The ConfirmSheet action row (both buttons) renders fully above the Android nav-bar band on an edge-to-edge device; the safe/bottom action's tap target is not occluded.
- A test proves it: assert the sheet's resolved bottom padding ≥ the nav-bar inset when one is supplied (unit on the ui component with an injected inset), OR a visual-harness (`pnpm --filter @bolusi/mobile test:visual`) frame showing the actions clear of the nav band. Never assert UI copy (testing-guide).
- `pnpm lint` / `pnpm typecheck` green. Inset has ONE source (no second 48dp literal).

## Falsify (§2.11)
- Set the injected inset to 0 (or remove the padding change) → the assertion that the action row clears the nav band must red. Restore → green. Report the falsification.
