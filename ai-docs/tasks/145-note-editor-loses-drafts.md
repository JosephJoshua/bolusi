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
