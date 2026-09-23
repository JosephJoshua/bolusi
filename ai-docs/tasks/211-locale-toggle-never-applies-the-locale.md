# TASK 211 — the in-app language toggle moves its checkmark but never changes the language

**Priority:** HIGH — user-facing, on the one surface an Indonesian-first product cannot afford to have broken. 07-i18n §1.2 and `SettingsScreen.tsx:4-8` both state that the language rows are the ONLY way back for a user stranded in a language they cannot read. They did not work.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** reading the `maestro-native-e2e` artifact of CI run 35849640615 (`main` @ `42f0fb3`), 2026-09-23 (CLAUDE.md §2.7 — the reproducing failure is the artifact screenshot, plus the RED test below).

## The reproducing failure

`06-i18n-toggle/takeScreenshot/i18n-02-en.png`, captured on the emulator lane immediately after tapping the English row: a green check sits on **English**, and every string on the screen is Indonesian — title "Pengaturan", sections "Bahasa" / "Keamanan" / "Notifikasi". The `en` catalog is not missing these; `core.settings.title` is `"Settings"` in `packages/i18n/src/generated/resources.ts`.

## Root cause (every call site enumerated, at HEAD `42f0fb3`)

1. `packages/i18n/src/instance.ts:92` `setLocale()` is the **only** function that changes i18next's active language.
2. Its only wrapper is `apps/mobile/src/i18n.ts` `writeDeviceLocale()`.
3. `writeDeviceLocale` had **zero production callers and zero tests**.
4. The live handler, `Root.tsx:920`, wrote the store directly and then called `setLocale(next)` — the **React `useState` setter** destructured at `Root.tsx:261`.
5. No `useEffect` synced the state back to i18next.

**There was no name shadowing, and the distinction matters.** `git show origin/main:apps/mobile/src/bootstrap/Root.tsx` imports only `bootstrapI18n` / `type LocaleStorePort` from `../i18n.js` and `type Locale` from `@bolusi/i18n`; the value `setLocale` was never in Root's scope, and `apps/mobile/src/i18n.ts` does not export it (it imports it privately and calls it inside `writeDeviceLocale`). So `setLocale(next)` was a valid, unambiguous call to the only `setLocale` there was. Nothing was masked — which is exactly why no compiler, linter or type could have caught this. The applying half of the operation was simply never wired up, and the surviving half looked complete because the name reads like the whole job.

The React state did change — which is why the checkmark moved — while `t()`, which reads the i18next instance at render, kept returning Indonesian. The choice was persisted, so the language changed on the **next app launch**, when `bootstrapI18n` re-read it.

## Why every existing gate was green (CLAUDE.md §2.11)

Three of the documented classes at once:

- **A well-tested function with zero callers.** `writeDeviceLocale` was correct the whole time; nothing called it. "A mention is not a producer — trace to one" (T-16).
- **A gate green for the wrong reason.** `.maestro/06-i18n-toggle.yaml` asserted `settings-locale-active-en` — a testID driven by the React state that *did* update. The flow could not fail on this defect, and its own screenshot is the evidence it missed.
- **The same miss one layer up.** `live-shell-settings.test.tsx` — the file written for task 124 precisely to catch "sound tests, zero callers" — asserted the locale rows *exist* and that the active one is *marked*. It never tapped one.

## The fix

- `apps/mobile/src/i18n.ts` — `writeDeviceLocale` applies the locale **before** its first `await`, then persists. Order is load-bearing twice: the apply must land in the caller's tick so the `setState` re-render renders the new language (there is no second render to correct it), and a failing persist must not cost the user their language.
- `apps/mobile/src/bootstrap/Root.tsx` — the handler calls `writeDeviceLocale`; the `useState` setter is renamed `setLocaleState`. The rename is **prophylactic, not the fix**: with the two spellings distinct a future import of the real applier cannot be masked, and a reader can tell which of the two operations a call site performs.
- `apps/mobile/src/screens/settings/SettingsScreen.tsx` — a `settings-rendered-locale-<locale>` node whose testID carries the locale `t()` is actually resolving in, read from the i18next instance rather than the `locale` prop. The active-row checkmark is `option === locale` and therefore structurally incapable of witnessing this defect; T-4 forbids the obvious alternative of asserting a rendered string, so the gate needs a testID that is wrong exactly when the copy is wrong.

## Acceptance

- [x] RED-first: the new `live-shell-settings.test.tsx` reproduction fails on the unfixed tree at `expect(i18n.language).toBe('en')` **after** the marker assertion passes — proving the marker is a false witness — and passes after the fix.
- [x] The test sources both expectations from the catalogs via `getFixedT`, so it asserts no UI copy (testing-guide) and survives rewording.
- [x] `.maestro/06-i18n-toggle.yaml` asserts `settings-rendered-locale-<locale>` on **both** arms, so the on-device gate can red on this defect — via a testID, not a rendered string (T-4).
- [x] Mobile suite, `pnpm lint`, `pnpm typecheck` green.

## Adjacent finding, NOT fixed here

The RED run emitted `01920000-…-119d0 lacks platform.set_locale for command setLocale (02-permissions §4)` from the best-effort per-user preference op (`Root.tsx` `notes?.setUserLocale`). 07-i18n §1.1 and 02-permissions §11 both say `platform.set_locale` is granted to **every role**, so a denial for the fixture's owner contradicts the spec.

It stopped reproducing after the fix (0 occurrences across three consecutive runs, vs 1 on the RED run), which is itself unexplained — nothing in this change touches permission evaluation. **Unresolved.** It is recorded here rather than filed as its own task because no reproducing failure currently exists for it (§2.7): the op is best-effort by design and its failure is swallowed into diagnostics, so there is no red test to point at. If it resurfaces, the reproduction is a `live-shell` test asserting the emitted `platform.user_locale_changed` op lands for an owner.
