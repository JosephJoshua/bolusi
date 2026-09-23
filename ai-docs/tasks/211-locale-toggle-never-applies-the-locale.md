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

### The witness's own first version was a guard that could not PASS

Worth recording, because it is the exact mirror of the defect this task fixes and only one lane could see it. The node started as an empty `<View testID={…} />` beside the section header. An empty View has **zero bounds**, and Maestro drops zero-bounds nodes from the accessibility hierarchy it queries — its own logcat says so: `Skipping invisible child: … boundsInParent: Rect(0, 0 - 0, 0)`. So the assertion could never succeed on a device.

Every local gate passed it: 1004 unit tests, typecheck, lint. `test-renderer` resolves `settings-rendered-locale-en` happily because it has no layout at all — the mobile vitest config states this limit in its own header ("CANNOT: Yoga layout"). It took an emulator run on the FIX branch to catch it:

```
CommandFailed: Assertion is false: id: settings-rendered-locale-en is visible
```

Fixed by wrapping the section header (a node with real bounds) instead of sitting beside it. **This is why lane A — the run that is "supposed" to just pass — is not optional.** A falsification run on the defect branch would have gone red either way and been read as success.
- [x] Mobile suite, `pnpm lint`, `pnpm typecheck` green.

## Second defect, found while fixing the first — the per-user locale op was denied on every tap

The RED run emitted `01920000-…-119d0 lacks platform.set_locale for command setLocale (02-permissions §4)` from the best-effort per-user preference op (`Root.tsx` `notes?.setUserLocale`).

**The trap on the way to the answer is worth recording, because it produced a confident wrong reading.** The warning appeared on defect runs and not on fixed runs — 3/3 vs 0/3, deterministic — which looks like causation and is not. Vitest's default reporter surfaces console output only for tests that FAIL. The defect runs were the failing runs. Proven, not reasoned: an **unconditional** `console.warn` placed in the handler printed nothing on a passing run. `EXIT=0`, `Tests 4 passed`, zero console lines. The denial was firing the whole time, on every tap, in a green suite.

Root cause: `apps/mobile/test/live-shell-support.tsx:183` `NOTES_PERMISSIONS` is a hand-mirror of the server's `staff` role (`apps/server/src/identity/permissions.ts` `STAFF_PERMS`) and had drifted by exactly one entry — `platform.set_locale`. **Production is unaffected**: all three seeded roles grant it. The damage was to coverage — the 07-i18n §1.1 signed, replicated preference op has a unit test (`user-locale.test.ts`) and was denied in every composed run, which is the same "tested in isolation, dead in composition" shape as the primary defect one layer up.

Why nothing could go red on it: Root fires the op best-effort and swallows failures into diagnostics **by design** (a stuck op-append must not block the language switch), and the diagnostic is only displayed when something else already failed. Two independent silencers in series.

Fixed here: the fixture mirror now carries `platform.set_locale` and names its source of truth, and `live-shell-settings.test.tsx` asserts the `platform.user_locale_changed` op actually lands. Falsified both ways — with the drifted fixture the assertion reds on `expected [] to have a length of 1`; with it corrected, green.
