# TASK 145 — a half-written note is destroyed two ways: Android hardware back EXITS THE APP from the editor, and any header-chrome tap discards the draft without the §8.1 confirm

**Status:** todo
**Priority:** **HIGH** — silent data loss on the reference module's core flow, on a product whose users are mechanics writing repair notes one-handed in a bright shop. Both paths bypass a discard gate that already exists and works.
**Depends on:** 96 (NotesHome/NoteEditor), 24 (zone/back), 124 (which added the third header control)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-124 reviewer, 2026-07-22 — both traced to a producer, neither previously filed (grepped 96 / 129 / 143 for `discard|unsaved|hardware back`: no coverage).

## Leg A — hardware back inside the editor exits the app (HIGH)

`backTarget({kind:'shell', route:'home'})` → **`exitApp`** (`navigation/zone.ts:110`), and `goBack` returns `false` (`App.tsx:140`). design-system §8.1 says hardware back always equals the header back action — and the editor's header back is the confirm-on-dirty `requestCancel`. It isn't equal: it's app exit.

**Concrete state:** open the note editor, type a body, press the Android hardware back button → **the app exits and the draft is gone**, with no confirm. The zone model treats "shell + route home" as top-of-stack because `NotesHome` owns its internal navigation privately, so the zone layer cannot see that an editor is open.

## Leg B — header chrome discards the draft with no confirm (MEDIUM)

`NoteEditor` has a working discard gate at `packages/modules/src/notes/screens/NoteEditor.tsx:221-226` (`requestCancel` → `if (dirty) setDiscardPrompt(true)`), which the header back honours. Tapping any header-right control unmounts `NotesHome` (`App.tsx:286-340`) and takes `NotesHome`'s `view` state and `EditorForm`'s `title`/`body`/`mediaRef` with it.

**Concrete input:** open the editor, type a title, tap the "Bahasa" chip → draft gone, no ConfirmSheet.

**This is a PRE-EXISTING class, not something task 124 introduced** — the SyncChip in the same header slot (`App.tsx:301`, `setRoute('syncStatus')`) already did exactly this. 124 inherited the slot's behaviour, which is why its reviewer approved it and filed this instead.

## Deliverable
Make both paths route through the SAME discard gate the header back already uses. That likely means the shell must be able to ask the active surface "are you dirty, and do you consent to leave?" rather than unmounting it — so expect a `ZoneInput`/shell-callback change, adjacent to task 143's. Read `design-system.md` §8.1 first; if the fix needs a new zone field or route value, say so explicitly in the commit (a navigation-model change).

## FALSIFY (§2.11 — REPORT it)
- Leg A: a composed test that opens the editor, dirties it, fires the real Android `BackHandler`, and asserts the app did **not** exit and the ConfirmSheet appeared. Break the fix → red. Restore → green. A test that only checks `backTarget`'s return value does NOT cover this — `zone.ts` is already tested and still produced `exitApp`.
- Leg B: same, driven through a header-chrome tap. **Positive control for both:** a CLEAN editor leaves immediately with no prompt, so "always prompts" cannot pass.


---

## ADDED 2026-07-22 from the task-143 review (LOW origin-drift — same header-chrome nav class this task owns)

143 merged the live-session switcher (a new `switching` ZoneInput + `origin: ShellRoute` so back returns to where the switch was opened). The 143 reviewer found a LOW wrinkle in the SAME header-chrome navigation area this task governs, so fold it in:

**Origin drift via the switcher's own sync chip.** On the live-session voluntary switcher, `SwitcherScreen` renders a `SyncChip` whose `onPress = onOpenSync = () => setRoute('syncStatus')` (`App.tsx:257`). While `switching` is still true the gate keeps showing the switcher (the chip looks inert), but `origin` silently becomes `syncStatus`, so a later back lands on Sync Status instead of where the switch was opened. Repro: home → avatar → tap the sync chip on the switcher → back → you're on Sync Status, not home. `switching` is never permanently stuck (back + PIN-success both clear it); it is only an origin wrinkle on an unusual path. Same class applies to a push-route arriving mid-switch.

**Fix direction:** ignore `onOpenSync` while a live-session switch is open, OR stop folding `route` into `origin` once `switching` is set. This is adjacent to this task's discard-gate work (both are "header-chrome taps during a modal-ish navigation state"), so close it here.

**Also — test-fidelity note (not a defect):** the 143 composed switcher test seeds a SINGLE user, so "the switch completes" exercises a same-user switch and asserts navigation only, not the emitted ops nor landing on a DIFFERENT incoming user's shell. The op emission is verified by construction in `@bolusi/core` (`session.ts` switchTo), but a two-user composed test that asserts the incoming user's shell + the `session_ended{switch}`/`user_switched` ops would harden it. Consider adding when you touch this area.
