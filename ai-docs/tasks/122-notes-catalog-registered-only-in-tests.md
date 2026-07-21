# TASK 122 — the notes i18n catalog is registered ONLY by a test-support file: `registerNotesCatalog` has zero production callers, so the shipping app renders `notes.*` labels in English to Indonesian-first users

**Status:** done
**Priority:** **MEDIUM-HIGH** — user-visible on an Indonesian-first product (00-product-overview: tech-inadept, Indonesian-first users). The reference module's entire UI chrome falls back to English. Not a security issue; a real product defect, and the purest instance of this repo's signature class.
**Depends on:** 96 (the screens + the catalog), 119 (the live shell that renders them)
**Blocks:** honest i18n claims for any module UI (every later module screen copies this pattern)
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, from LOOKING at task 116's screenshot of the live notes list.

## The finding (measured, not reasoned)

`grep -rn "registerNotesCatalog(" --include="*.ts*"` over the repo (excluding node_modules/dist/worktrees) returns exactly ONE call site:

```
apps/mobile/test/notes-support.tsx:31:  registerNotesCatalog({ id: idCatalog, en: enCatalog });
```

That is a **test-support file**. There is no production caller — not in `apps/mobile/index.ts`, not in `Root.tsx`, not in `index.web.tsx`. So `notes.*` keys never resolve in the shipping app and fall back to English.

**Proof it is live, from the rendered UI** (task 116's `app-shell.png`, rendering the real `NotesList` through task 119's live runtime): the header reads **"Title"**, the filter reads **"Show archived"**, the CTA reads **"New"** — while the core-namespace sync chip on the SAME screen correctly reads **"Belum terkirim"**. The core catalog resolves; the module catalog does not.

And the Indonesian catalog is complete and correct — `packages/modules/notes/i18n/id.json` has `list.title: "Catatan"`, `filter.showArchived: "Tampilkan arsip"`, `action.new: "Catatan Baru"`. Nothing is missing except the call that loads it.

## Why every test stayed green (the class)

`apps/mobile/test/notes-support.tsx` calls `registerNotesCatalog` in the test's own setup. So task 96's mounted-render tests resolve `notes.*` correctly — **the test supplies the wiring the product lacks**. A test cannot detect a gap it is itself filling. This is the mirror of task 69 (tests green while the screen was unwired) and the same family as 40→102, 20→105, 96→119: a mechanism that exists, is exported, is tested, and has no production caller. Standing check: *"who binds this in production?"* — here, nobody.

## Deliverable
- Call `registerNotesCatalog` (with the shipped `id`/`en` catalogs) on the **real app boot path** — `apps/mobile` native entry AND `index.web.tsx` (task 116's web entry), wherever `initI18n` runs, so module catalogs load before any screen resolves a label (07-i18n §3.3).
- Prefer a mechanism that generalises: module catalogs should register as part of module registration (`ALL_MODULES`, task 90) rather than a hand-written call per module — otherwise the next module repeats this exactly. If that is a larger refactor, ship the direct call now and file the generalisation.

## FALSIFY (§2.11 — the crux; a test that uses `notes-support.tsx` PROVES NOTHING here)
- Add a test that exercises the **PRODUCTION boot path** (mount `Root` / drive the real entry, as task 119's `live-shell-notes.test.tsx` does — NOT the test-support harness) and asserts a `notes.*` label resolves to its **Indonesian** value (e.g. the list header is "Catatan", not "Title"/"notes.list.title").
- Then REMOVE the production `registerNotesCatalog` call → that test must go RED (label falls back to English/key) → restore → green. If it stays green, your test is still being fed by `notes-support.tsx` and proves nothing.
- Regenerate task 116's screenshots and confirm `app-shell.png` shows Indonesian chrome ("Catatan" / "Tampilkan arsip" / "Catatan Baru").

## Constraints
Touches `apps/mobile` boot + web entry (+ possibly module registration). Coordinate with any in-flight `apps/mobile` agent (task 120 owns that thread at filing time). Do NOT edit the catalogs — they are correct; only the loading is missing.

## Note
Filed from a screenshot, not a test run. The visual harness (116) existed for less than an hour before it caught a real user-visible defect that ~600 green mobile tests could not, because the tests wire the very thing production forgets. That is the argument for the harness, written in one bug.
