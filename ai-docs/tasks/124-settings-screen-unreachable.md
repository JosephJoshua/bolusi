# TASK 124 — the Settings screen has no producer: `setRoute('settings')` is called nowhere, so language, device identity and notification settings are unreachable in the shipping app

**Status:** todo
**Priority:** **HIGH — user-visible on an Indonesian-first product.** The language toggle is the ONLY UI for the device locale (07-i18n §1.2); a user who cannot reach Settings cannot choose or recover their language. The device-ID/store/tenant readout exists specifically "so the shop can read its own device's identity to an owner over the phone during a revocation" (`settings/model.ts:18-19`) — unreachable. The notification-settings deep-link (api/04-push §5, task 59) — unreachable.
**Depends on:** 24 (app shell / navigation), 119 (live session shell)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA visual state-map sweep, 2026-07-22.

## The finding (verified by the orchestrator, not inferred)

`grep -rn "setRoute('settings')" apps/mobile/src apps/mobile/App.tsx` → **no production call site.** `'settings'` appears in exactly three non-test places: the type (`navigation/zone.ts:28`), the render arm (`App.tsx:264`), and the harness gallery. `backTarget` (`zone.ts:95-112`) only ever yields `route: 'home'`.

**The arm is live and correct — only the producer is missing.** The QA agent patched `App.tsx:108` `useState<ShellRoute>('home')` → `'settings'`, rebuilt (EXIT=0), and the full SettingsScreen rendered inside the real App gate with real props ("Bahasa / Bahasa Indonesia / Oke / English / Peringatan perangkat…"), then reverted (tree clean). Exhaustive DOM enumeration of every interactive element in app mode found no entry point: `app/shell` offers only syncChip→syncStatus, avatarButton→switcher, the archived toggle, note rows, and create; `app/switcher` offers back, syncChip, user cards.

This is CLAUDE.md §2.11's "sound tests, zero callers" class — the screen is built, styled, tested and typed, and no user can open it.

## Deliverable
- Add the missing entry point per `design-system.md` §8 navigation (the natural home is the app-shell header — beside/behind the avatar — or the switcher; pick what §8 specifies and cite it). Keep it reachable one-handed (§0/§1.4).
- **Falsify (§2.11):** a composed-app test (task 69's render lane / the live-shell harness) that drives the REAL shell to Settings and asserts it renders; remove the entry point → RED → restore → green. A test that calls `setRoute('settings')` directly proves nothing — it must go through the affordance a user taps.
- Regenerate task 116's screenshots and confirm Settings is reachable from `app/shell` in the artifacts.

## Note
The screen was verified correct in isolation by its own tests for the entire time it was unreachable — which is exactly why only a state-map sweep over the RUNNING shell found it.
