# TASK 129 — design-system conformance batch on the new screens: wrong titles, missing required fields, two primaries, overflow, and a truncating unauthorized hint

**Status:** todo
**Priority:** MEDIUM — none is a crash; together they are what a shop owner actually sees. Every one is invisible to the current suite, which asserts testIDs exist rather than what is in them.
**Depends on:** 96, 82, 24, 119
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA visual state-map + spec-verify sweeps, 2026-07-22. Each item was reproduced against a named screenshot or `file:line`.

## Items (each independently checkable)

1. **Settings uses three wrong label keys** (`SettingsScreen.tsx`): `:63` titles the whole screen `core.settings.language` → "Bahasa"/"Language" though it holds language + notifications + device info (no `settings.title` key exists — the gap was papered over); `:106` section header `push.device.title` is the SAME string as the `device` row it heads (`:114`); `:121` heads the read-only device-info block with `auth.enroll.title` = "Daftarkan Perangkat Ini"/"Enroll This Device" — an imperative CTA over information rows. Keys resolve, the id/en parity gate is green, `no-hardcoded-strings` is green — only pixels show it.
2. **Two primaries on an empty NotesList** (`NotesList.tsx:125` and `:144` both gate on `canCreate`): design-system §3.1 — `primary` is "THE action of the screen. Max one visible per screen." Affects ANY empty list, including a new store's first screen. In the **archived-empty** view it is three (the toggle also flips to `primary`), and the copy is wrong too: viewing the archive with active notes present says "Belum ada catatan. Ketuk 'Catatan Baru' untuk mulai." and offers a CTA that creates an *active* note which will not appear in that view.
3. **Archived toggle label never changes** (`NotesList.tsx:156`): always `notes.filter.showArchived` ("Show archived") even while the archive IS shown; only the fill colour changes, with the "Diarsipkan" text cue stranded at the bottom. §6.3 forbids colour-only signalling.
4. **NoteDetail omits the author** (`NoteDetail.tsx:204-206` renders only `formatRelative`): §8.6 requires "meta line (**author**, time)". `NoteRow` already carries `createdBy`/`lastEditedBy`. Attribution on a shared device is the product premise (§8.1). Also `:103` titles the detail screen `notes.list.title` ("Catatan") — identical to the list header.
5. **Rejected rows omit op type and rejection code** (`SyncStatusScreen.tsx:200-206`): §8.4 item 4 requires "op type label, time, **rejection code**". A shop owner calling support has nothing to quote. (Note: the generic "Terjadi kesalahan" text in the artifact is a harness-seed artifact — `seed.ts:140` uses `rejectionCode: 'STALE_WRITE'`, which appears in no spec and has no catalog row; the missing columns are the product defect. Side effect: no artifact has ever rendered a REAL rejection code.)
6. **Switcher cards omit the role name** (`SwitcherScreen.tsx`, `switcher/model.ts:27-36` has no role field): §8.2 requires "role name `type.bodySm` `textMuted`".
7. **Sync-status counters overflow** (`SyncStatusScreen.tsx:286` — two `Card`s in a row with no `flex: 1`): measured right edge 393px at BOTH 390 and 360 viewports; at 360 the document scrolls horizontally (`scrollWidth 393 / clientWidth 360`) and the right card clips. §0 targets small Android screens and requires tolerating +30% text expansion.
8. **`UnauthorizedState` hint truncates at 2 lines** (`UnauthorizedState.tsx:51` hard-caps `numberOfLines={2}`): at 1.3× font scale the guidance reads "Contact the store owner t…". §9: "Text survives 1.3× font scale and ID/EN length variance without truncation." *(The 1.3× lane is an RNW approximation — re-confirm on device.)*
9. **Unauthorized state is missing its required guidance body** (`NotesList.tsx:99-106`, `NoteEditor.tsx:109-115`, `NoteDetail.tsx:148-154`): §5 Unauthorized MUST contain "explicit permission-denied title + **body ('ask your store owner' guidance)** + back CTA". All three pass title + back and omit `hint`; no such guidance key exists in `ui-labels.md` or the core catalogs. §8.6 calls the notes denial exit "the reference proof" — every later module will copy it.

## Deliverable
Fix each, adding catalog keys where one is genuinely missing (do not reuse a semantically-wrong key to make a string appear). For each, add or extend a render test that asserts the CONTENT, not just the testID — that gap is why all nine shipped green. Regenerate the 116 screenshots and re-inspect.


---

## ADDED 2026-07-22 (found by the task-125 implementer, same class, different file)

10. **`apps/mobile/src/media/SignaturePadScreen.tsx:235` has the identical `failed`-branch defect task 125 fixed in `CaptureScreen`:** `title={t('core.errors.UNEXPECTED')}` sits beside a live `errorCode={state.code}`, so a failure whose code the catalog DOES cover still reads "Terjadi kesalahan. Coba lagi." Fix is the same one line — `translateErrorCode(state.code)` (07-i18n §4.2's derived lookup, already exported); uncovered codes still degrade to UNEXPECTED.
11. **`SignaturePadScreen.tsx:213`'s `UnauthorizedState` ships no `hint` at all** — design-system §5 requires body guidance. Note its title (`core.errors.PERMISSION_DENIED`) IS correct here: unlike `CaptureScreen`'s OS-permission case, this is an *account* denial, so the fix is to add guidance, not to change the title.

12. **The note TITLE in edit mode reads as an unfilled placeholder** (visually confirmed on `artifacts/notes-editor-long-body.png` by the task-128 implementer). The title is the note's real value, rendered in `color.textDisabled` grey because edit-mode expresses read-only via `disabled` — and design-system §6.1 **exempts disabled text from the 4.5:1 contrast floor**, so no contrast gate fires on it. **This needs a decision before code:** either the design system grows a distinct read-only treatment (a new component state in a contended package — CLAUDE.md §6 territory), or §6.1 records why `disabled` is the right expression of read-only here. Do not silently restyle it.
