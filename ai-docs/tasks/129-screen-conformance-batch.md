# TASK 129 — design-system conformance batch on the new screens: wrong titles, missing required fields, two primaries, overflow, and a truncating unauthorized hint

**Status:** todo
**Priority:** MEDIUM — none is a crash; together they are what a shop owner actually sees. Every one is invisible to the current suite, which asserts testIDs exist rather than what is in them.

> **ITEM 13 DONE 2026-08-05** (EmptyState 2-line cap). `EmptyState`'s hint `numberOfLines` widened 2→3 (contended `@bolusi/ui`), following `Banner`'s dated task-23 precedent (§3.6): a compliant Indonesian empty-state hint (§5 "what happened + what to do", 07-i18n §7.2) fills two `bodySm` lines at 360dp and overflows at the 1.3× scale §6.5 requires — a truncated "what to do" reads as "nothing here" (the FR-1036 trap). Owner-ruled: GROW, not a §6.5 exemption. design-system §3.8 documents the change (matches Banner's 3-line budget). **§2.11-falsified:** a `components.test` asserts the hint's `numberOfLines === 3`; reverting to 2 reds it. ui 68/68, mobile suite + lint green, ui dist rebuilt.
>
> **PARTIAL — ITEM 7 DONE 2026-08-05** (counter overflow). The two `SyncStatusScreen` pending counters now each sit in a `flex: 1` cell (`counterCell`), so they SHARE the row instead of sizing to content — at 360 dp a wide Indonesian label (the +30% expansion §0 requires) pushed the right card past the viewport and scrolled the screen horizontally; the label now wraps inside its half-width card. `Card` stays style-less (design-system §3.4 forbids the ad-hoc `style` prop that would let it flex directly), so the fix is a consumer-side cell wrapper, not a contended-UI change. **No pixel lane in this harness** (T-11 — the real proof is the visual/device lane); the guard is STRUCTURAL — a render test asserts each cell's `flex === 1`, **§2.11-falsified** (emptying `counterCell` reds it). mobile 819/819, lint + typecheck green.
>
> **ITEM 5 DEFERRED (needs a decision, same class as 4a/6).** Rejected rows already show the rejection reason (translated) + time + the raw code in the tap-detail; the genuinely-missing §8.4-item-4 field is the **op-type LABEL** (`row.type`, e.g. `notes.note_created`). There is NO op-type label source anywhere in the repo (grep: no `sync.opType.*`, no module-provided op-type labels), so this needs a decision — a `sync.opType.<type>` catalog set in the shell (which leaks module op-names into the shell catalog) vs each module providing labels for its own op types. Not a screen nit; pairs with 4a (author name) / 6 (role name) as a labeling/enrichment slice.
>
> **PARTIAL — item 12 DONE 2026-08-05** (owner-ruled: ADD a read-only text state, not a §6.1 rationale). `TextInput` (`@bolusi/ui`, contended §4) gained a `readOnly` state distinct from `disabled`: both are non-editable, but `disabled` greys the value (`textDisabled`, the one §6.1 contrast-floor exemption) while `readOnly` keeps FULL-CONTRAST `color.text` + `surface` fill + never focuses — the value is real, just not editable. NoteEditor's edit-mode title switched `disabled` → `readOnly` (its intent since 01 §9, comment line 419), so the note title no longer reads as an unfilled placeholder. design-system §3.2 documents the new state + the disabled-vs-readOnly distinction. **§2.11-falsified:** making `readOnly` grey the value reds the ui readOnly test; reverting NoteEditor to `disabled` reds the screen's full-contrast assertion. Additive (existing callers unchanged, `readOnly` defaults false); ui 67/67, NoteEditor 11/11.
>
> **PARTIAL — items 4b + 10 DONE 2026-08-05** (screen-copy correctness). **Item 4b:** NoteDetail's screen title was `notes.list.title` ("Catatan"/"Notes") — the LIST's key — → now `notes.detail.title` ("Catatan"/"Note"); the keys render identical copy in ID and diverge only in EN, so the render test compares the two REAL screen titles in EN (T-4-clean) and reds on revert (falsified with the `tsc -b` dist rebuild). New `notes.detail.title` key (3-place: ui-labels + module catalog + `NotesKey`, parity denominator 13→14). **Item 10:** SignaturePad's `failed` branch titled `core.errors.UNEXPECTED` beside a live `errorCode` → now `translateErrorCode(state.code)` (07-i18n §4.2's derived lookup, the same fix task 125 made in CaptureScreen); a catalog-COVERED code now reads its real message, uncovered still degrades to UNEXPECTED. Test uses a covered code (`LOCAL_CORRUPT`); reverting reds it. **§2.11-falsified both; full mobile 792/792, modules 58/58, no live-shell ripple. ITEM 4a (author on the meta line) DEFERRED:** rendering the author needs name resolution the `NotesRuntime` does not expose (`NoteRow` carries `createdBy`/`lastEditedBy` IDs only) — a data-layer/contract change (add `resolveUserName` to the runtime, or `createdByName` to `NoteRow` via the getNote query), not a screen nit. Pairs with item 6 (switcher role name) as a "NotesRuntime/bundle enrichment" slice.
>
> **PARTIAL — item 1 DONE 2026-08-05** (Settings three wrong/duplicate label keys). The screen title was `core.settings.language` (the language section's own header) → now `core.settings.title` ("Pengaturan"/"Settings"); the NOTIFICATIONS section header was `push.device.title` (identical to the `device` category row it heads) → now `core.settings.notifications`; the device-info block header was `auth.enroll.title` ("Daftarkan Perangkat Ini" — an imperative CTA over read-only rows) → now `core.settings.device` ("Perangkat Ini"/"This Device"). Three new `core.settings.*` keys (ui-labels.md → core catalog, 10 gates green). Section headers got testIDs; the render test asserts each label moved OFF its old colliding key (compare to `t(oldKey)`, not a hardcoded copy — T-4) + the three headers are mutually distinct. **§2.11-falsified: reverting each site to its old key reds exactly its assertion (same-package, no dist rebuild) — restored, 8/8; full mobile suite 791/791 (no live-shell ripple).**
>
> **PARTIAL — items 2 + 3 DONE 2026-08-05** (NotesList §3.1/§6.3). §3.1 max-one-primary: the persistent bottom-action create now shows ONLY in the active view WITH rows (the active-empty state owns the sole create CTA; two primaries on empty was item 2), and the archived view offers NO create at all — the archived-empty state shows `notes.list.emptyArchived` with no CTA (a "New Note" there files an ACTIVE note the view can't show, item 2). §6.3 colour-only: the archived toggle's state now rides its LABEL (`notes.filter.showArchived` ⇄ `notes.filter.hideArchived`), variant always `secondary` — which also removed its primary-flip (the 3rd primary in archived-empty). Two new keys across ui-labels.md + the module catalog + `NotesKey` (parity denominator 11→13). Render tests assert primary COUNT (create-CTA presence per state) + that the toggle label RESPONDS to state (structure, not copy — T-4); **§2.11-falsified: always-on bottomAction reds the two one-primary tests; static toggle label reds the label test; removing the archived-empty branch reds the archived-no-CTA test — each restored, 11/11 green. (Falsification initially ran against stale `@bolusi/modules` DIST — the mobile tests import the built package — and passed for the wrong reason until `tsc -b` was run between mutation and test; §2.1.)**
>
> **PARTIAL — items 9 + 11 DONE 2026-08-05** (the §5 Unauthorized-guidance-body class, shared with task 146 item 1). All four Unauthorized states that shipped a title with no body now pass `hint={t('core.unauthorized.askOwner')}` — the one new shared key ("Minta pemilik toko untuk memberi akses." / "Ask your store owner for access.", `ui-labels.md` → catalogs → typed union, 10 gates green): `NotesList`/`NoteEditor`/`NoteDetail` (`@bolusi/modules`) + `SignaturePadScreen` (mobile). Each existing mobile render test (`{NotesList,NoteEditor,NoteDetail}.test.tsx`, `SignaturePadScreen.test.tsx`) now asserts the `.hint` node is PRESENT (structure, not copy — T-4); **§2.11-falsified: dropping the `hint` prop from each screen reds its assertion, restored → 44/44 green.** REMAINING: items 1–8, 10 (`SignaturePad` failed-branch `translateErrorCode` — a different class, error-code display), 12 (needs a design decision — read-only text treatment, §6 territory), 13 (contended `packages/ui` + no 1.3× render lane).
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

## ADDED 2026-07-23 (found by the task-130 implementer, adjudicated by its reviewer)

13. **`EmptyState`'s 2-line hint cap cannot hold a compliant Indonesian empty-state string — same class as item 6's truncating unauthorized hint, and now demonstrated with a dated precedent.**

`packages/ui/src/components/EmptyState.tsx:52` clamps the hint at `numberOfLines={2}`. The switcher's
empty-roster guidance (`auth.switcher.emptyUsers`, 78 chars ID) renders as **exactly two lines with
the second near-full-width** — read off `apps/mobile/e2e-web/artifacts/switcher-empty.png`, not
inferred from a green. Zero headroom at 1.0×, so it must clip at the **1.3× font scale
design-system §6.5 requires us to survive**.

**The precedent is already in the design system.** `ai-docs/design-system.md:198` records a **67-char**
Indonesian `bodySm` string that *"already fills two `bodySm` lines on a 360 dp screen and overflows
them at the 1.3× font scale §6.5 requires us to survive"* — which is why `Banner` was widened 2→3
lines (`packages/ui/test/banner.test.tsx:157`). The new string is **11 characters longer**, in the
same `type.bodySm`, at a **narrower** content width (`EmptyState`'s root carries `padding: space.xl`
= 24 each side). The same reasoning that moved Banner applies here and was not applied.

**This PREDATES task 130.** The prior hint was `auth.enroll.instruction` (69 chars ID) — already over
the documented 67-char threshold. Task 130 lengthens it 69 → 78; it did not create the class.

**It is also not really a copy problem, which is why trimming the string is the wrong fix.**
design-system §5 requires an Empty state to say what to do, and 07-i18n §7.2 requires "what happened,
then what to do" — two sentences. A two-sentence Indonesian hint does not fit a 2-line cap at 1.3×.
Either `EmptyState` grows to 3 lines as `Banner` did, or §6.5 records why this surface is exempt.

**Why no gate caught it, and the gap that leaves:** **there is no 1.3×-scale render gate anywhere in
this repo.** The visual harness renders at 1× (39/39 green on the very screenshot that shows the
overflow), and `banner.test.tsx:157` asserts a `numberOfLines` *value*, not a rendered result. So
every §6.5 claim in this project currently rests on arithmetic and eyeballing. That is worth its own
task — filing a 1.3× lane would convert this whole class from "someone noticed" to "the gate reds" —
but it is out of scope here.

**Contended:** `packages/ui` (CLAUDE.md §4). Serialize with any other design-system work.
