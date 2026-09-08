# TASK 206 — AppShell content area is a plain View, not scrollable: long screens clip on small / large-font devices

**Priority:** MEDIUM-HIGH — the target hardware is low-end 2GB Android with small screens, and tech-inadept users who raise the OS font scale (design-system §0). Both shrink the viewport, and any screen taller than it has content below the fold that is simply unreachable — no scroll.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the QA sweep of the 201-B emulator surface, 2026-09-08 (CLAUDE.md §2.7).

## The finding (citations verified at the producer, HEAD 17868eb)

`packages/ui/src/shell/AppShell.tsx` frames every screen but never provides a scroll container:

- `:76` `content: { flex: 1, padding: space.lg }` — the content slot is a plain padded `View`.
- `grep -c ScrollView packages/ui/src/shell/AppShell.tsx` → `0`. The header row, title, and content are all `View`s; nothing scrolls.

The screens rendered into that slot supply no scroll container of their own either:

- `apps/mobile/src/screens/settings/SettingsScreen.tsx` — `ScrollView` count `0`.
- `apps/mobile/src/screens/sync-status/SyncStatusScreen.tsx` — `ScrollView` count `0`.
- `apps/mobile/src/screens/pin/PinScreen.tsx` — `ScrollView` count `0`.

So the whole shell→screen chain for these screens is `View` all the way down. When the intrinsic content height exceeds the viewport (small screen, or large font scale, or both — SyncStatus renders counters + per-status lists; Settings renders a stack of rows), the overflow is clipped and there is no gesture to reach it. This is the design-system "mandatory states" gap: a screen that cannot show all its own content on the target device.

Not caught by tests: the RNW visual harness (task 116) renders at a desktop viewport where everything fits, and unit tests mount without a fixed viewport, so neither exercises the clip. The emulator lane's flows assert specific testIDs that happen to be above the fold.

## Fix direction (owner-facing — this is the contended @bolusi/ui design system, §4)

Make the content slot scrollable by default. Preferred: wrap the `content` slot in a `ScrollView` (with `contentContainerStyle` carrying the `space.lg` padding and `flexGrow: 1` so short screens still fill and can center), inside `AppShell` so every screen inherits it — one implementation, not per-screen (§2.8). Screens that need a fixed non-scrolling region (e.g. a pinned action bar) opt out via a prop.

Watch-outs:
- A `flex: 1` child inside a `ScrollView` collapses; the empty/centered states (EmptyState, PinScreen's centered layout) need `flexGrow: 1` on the content container + `justifyContent`, not `flex: 1` on a child.
- Keep the header row OUTSIDE the scroll (title/back stay pinned).
- Preserve the existing `padding: space.lg` visual result.

## Acceptance
- With a viewport shorter than the content, all content is reachable by scrolling on AppShell-framed screens (Settings, SyncStatus, Pin at minimum).
- Short screens still fill the viewport and center as before (no regression to EmptyState / PinScreen layout).
- A test proves it: mount a screen taller than a constrained viewport and assert the bottom-most element becomes reachable / the container is scrollable; or a visual-harness frame at a small viewport + large font scale. Never assert UI copy (testing-guide).
- `pnpm lint` / `pnpm typecheck` green; the scroll lives once in AppShell, not copied per screen.

## Falsify (§2.11)
- Revert the content slot to a plain `View` → the "bottom element reachable at a constrained viewport" assertion must red. Restore → green. Report the falsification.
