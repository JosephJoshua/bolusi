# TASK 150 — catalog-guard residuals: blank strings pass for every module but `notes`, and a comment points at the wrong assertion

**Status:** done
**Priority:** LOW-MEDIUM — item 1 undercuts the exact thing task 132 item 3 was built for (generalizing past the `notes`-pinned tests). Item 2 is the §2.11 comment class, in a file that itself cites "a comment is a hypothesis, not evidence".
**Depends on:** 132 (items 2-3, merged 2026-07-22), 123
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-132 reviewer, 2026-07-22, on the approving pass.

## 1. LOW-MEDIUM — blank catalog values pass, and only the `notes`-pinned tests catch them

`leafPaths` counts `""` as a leaf, and i18next `exists()` is true for a defined-but-empty value. The reviewer blanked all 22 `notes` values:
- `module-catalog-coverage.test.ts` → **12/12 green, EXIT=0**
- `pnpm i18n:check` → **all 9 gates green, EXIT=0**
- the full mobile lane DID catch it — `3 failed` — **but all three failures were in `notes-catalog-boot.test.tsx` and `NotesList.test.tsx`**, i.e. exactly the `notes`-pinned tests that task 132 item 3 exists to generalize past.

**So for module #2 — the entire point of the work — a blank catalog would ship silently.** Fix: a companion detector asserting `typeof value === 'string' && value.trim() !== ''`.

## 2. MEDIUM — a comment misattributes which assertion catches a starved parse

`module-catalog-coverage.test.ts:316-318` claims the leaf-count floor catches "a `leafPaths` that stopped descending". It does not. With `leafPaths` made depth-1 the floor computed **12** (6 top-level keys × 2 locales) **≥ 10 → stayed green**, and `unresolvedCatalogKeys` also stayed green because i18next `exists()` returns true for a parent object node like `notes.action`. **Only the dedicated `leafPaths descends nested trees` unit test went red.**

The case *is* caught, so the guard is sound — the comment simply points at the wrong assertion. Reword: the floor catches an empty registry / empty trees (proven — emptying the real catalogs reds it at line 319, `expected 0 to be greater than or equal to 10`); the depth guarantee belongs to the `leafPaths` unit test.

## 3. LOW — the RN `BackHandler` double diverges from the platform, in the SAFE direction

Real RN 0.86 dedupes on add (`if (indexOf(handler) === -1) push`); `apps/mobile/test/doubles/react-native.tsx` pushes unconditionally. So `useHardwareBack.test.tsx`'s "subscribed exactly once" test is **stricter than the platform** — Android would silently dedupe the duplicate registration it guards against. That is a false-**red** risk, never a false-green, so it is not urgent; but the divergence should be documented in the double so nobody later "fixes" the test to match a platform behaviour the double does not model. Two further inert divergences: RN passes a `HardwareBackPressEvent` argument (the double calls with none), and RN ignores `eventName` on add (the double early-returns a no-op subscription).

## 4. INFO — the denominator's own denominator is unguarded
`unparsedScreensExportKeys` only inspects keys matching `^\./[^/]+/screens$`. A screen-bearing module exported under a different shape (e.g. `./notes/ui`) still drops out of both sides silently. Out of scope for 132 — boundary rule 3 makes `./<id>/screens` the only legal shape — but worth a line somewhere that the legality is enforced by the boundary rule, not by this guard.

## 5. Add to the `useHardwareBack` limits section — predictive back may invalidate the PREMISE, not just be untested
The shipped limits section is honest and unusually complete. Two additions the reviewer would sign it with:
- The double is **stricter than shipped RN 0.86** (item 3), so the "subscribed exactly once" test measures the double's policy, not Android's.
- **Android 13+/14 predictive back changes the dispatch model** (`OnBackInvokedCallback` rather than `onBackPressed`), and under `android:enableOnBackInvokedCallback` RN routes `BackHandler` listeners through a compatibility shim whose ordering relative to native callbacks is **not the JS array order this lane models**. The current section names predictive back as an untested *path*; it does not say predictive back could invalidate the ordering *premise* the whole argument rests on. That gap is invisible to a doc-derived double by construction — only an on-device (L6) run closes it, and task 148 currently blocks any Android build at all.

## FALSIFY (§2.11 — REPORT it)
For item 1: blank the real `notes` catalog values and confirm the NEW detector reds while the old assertions still pass (that asymmetry is the finding). Positive control: a legitimately short-but-non-blank value must NOT red.

### Falsification record (implementer, 2026-07-23)

**Item 1 — the asymmetry, in one run.** Blanked all 22 real `notes` values. `blankCatalogValues` red,
naming all 22 leaves (`expected [ 'en:notes.action.archive', …(21) ] to deeply equal []`); the other
**13 assertions in the file all passed**, and `pnpm i18n:check` stayed 9/9 green (EXIT=0). The full
mobile lane's only reds were 3 tests in `notes-catalog-boot.test.tsx` / `NotesList.test.tsx` — the
`notes`-pinned tests, exactly as filed. Positive control: `notes.list.title = "OK"` → 14/14 green,
EXIT=0. Shapes: `"   "`, `null` and `42` in the real catalog are each named individually
(`id:notes.list.title`, `id:notes.badge.archived`, `id:notes.action.new`), with the other 13
assertions still green — so every blank shape was invisible to the pre-existing guard, not just `""`.

**Item 2 — both halves measured.** Forcing the descent to depth 1 left `the production boot RESOLVES
every shipped leaf` **fully GREEN** (verified per-test with `--reporter=verbose`, not inferred from a
failure list): the floor computes 12 ≥ 10 and `unresolvedCatalogKeys` passes on parent nodes. Only
the `leafPaths descends nested trees` unit test owns that guarantee. Emptying the real catalogs reds
the floor with exactly `expected 0 to be greater than or equal to 10`, as the task predicted.
**The reword had to be corrected once by its own falsification**: the first draft claimed the unit
test was the *only* assertion that reds for a starved parse, and the depth-1 run showed
`blankCatalogValues` reds too (a parent node is not a string). The comment now says that, and marks
it a side effect not to be relied on.

**Item 5 — the docs partly CORRECTED the task's claim.** The premise holds and is stronger than
filed, but the polarity in the task text is wrong for current Android. Android 16 (API 36) behaviour
changes state that for apps targeting 36 on a 36+ device, predictive back animations are enabled **by
default** and "`onBackPressed` is not called and `KeyEvent.KEYCODE_BACK` is not dispatched anymore" —
so `android:enableOnBackInvokedCallback` is now the temporary **opt-out**, not the opt-in it was on
Android 13/14. RN 0.86's own `ReactActivity.java` corroborates it in shipped source: it registers an
`androidx.activity.OnBackPressedCallback` gated on `AndroidVersion.isAtLeastTargetSdk36`, commented
"Due to enforced predictive back on targetSdk 36, 'onBackPressed()' is disabled by default. Using a
workaround to trigger it manually." One refinement to the task's wording: the reverse-order rule
*within* the JS array is unchanged (RN still iterates `_backPressSubscriptions` backwards), so what
is unmodelled is the JS stack's **position and liveness in the native dispatcher**, not the JS order
itself. Written up that way.

**Item 3 — verified at the source, not the docs.** All three divergences confirmed in
`react-native@0.86.0/Libraries/Utilities/BackHandler.android.js`: dedupe on add
(`if (indexOf(handler) === -1) push`), a `HardwareBackPressEvent` argument passed to each listener,
and `eventName` never inspected on add.

**Found but not fixed:** the same blank-value class on the **seed** leg — a blank cell in
`ui-labels.md` seeds a blank reserved-namespace label and all 9 gates pass (EXIT=0), reproduced
end-to-end. Filed as **task 165**.
