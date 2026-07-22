# TASK 143 — the User Switcher is unreachable once a session is open: the avatar button is a dead control, and PRD-011's shared-device quick-switch does not exist

**Status:** todo
**Priority:** **HIGH** — same class as task 124 (a built, tested screen with no reachable producer), on the feature that justifies the shared-device product shape. `design-system.md` §8.1 says "tap the avatar → User Switcher"; tapping it does nothing.
**Depends on:** 24 (the navigation zone), 124 (which proved the class and shares `App.tsx`)
**Blocks:** —
**SEC ids owned by THIS task:** none — but note the interaction with task 133: a shop counter that can neither lock nor switch user has no way to change hands safely.
**Filed by:** the task-124 implementer, 2026-07-22; **probed, not inferred**.

## The finding

`resolveZone` returns `{kind:'shell'}` whenever `session !== null && pinFor === null`, so no input reachable from a live session can produce the switcher zone. The only writer anywhere is `setPinFor(null)` (`App.tsx` NotesHome avatar; `SyncStatusScreen.onOpenSwitcher`) — which is a **no-op in that state**.

**Probe (not a reading):** a throwaway live-shell test tapped `ui.avatarButton` after a real PIN unlock →
```
AFTER AVATAR TAP: switcher-screen = ABSENT | notes list = PRESENT
```

Related, same cause: **`SettingsScreen.onOpenSwitcher` is wired to `setRoute('home')`** (`App.tsx:275`) — the avatar on Settings navigates to the notes list, not the switcher.

## Why it was not fixed in 124
It needs a new `ZoneInput` field to express "session open, user wants to switch" — a navigation-model change, not a wiring fix. Task 124 correctly refused to smuggle a redesign into its slice.

## Deliverable
Extend the zone model so a live session can reach the switcher, wire the avatar (both surfaces) to it, and make the return path correct (`backTarget` from the switcher must land where the user came from, not unconditionally home). Read `design-system.md` §8.1 and `api/02-auth.md` §6.2 first — switching user is a session operation with an op behind it, not just navigation.

## FALSIFY (§2.11 — REPORT it)
- A composed test that unlocks a real session, taps the avatar, and asserts the **switcher's real content** renders (not that a testID exists — task 124's break-the-target technique is the model: keep the node and its handler, change only what the handler does, and confirm the test still reds).
- Positive control: the avatar is absent/inert where a switch is genuinely not available (pre-session), so "always renders the switcher" cannot pass.
- Back from the switcher returns to the surface the user left.

## Constraints
`App.tsx` / `navigation/zone.ts` are contended (124 landed, 133/135/136 queued) — serialize. A new zone/route value is a navigation-model change: state it explicitly in the commit and update `design-system.md` §8.1 if the doc's description no longer matches.
