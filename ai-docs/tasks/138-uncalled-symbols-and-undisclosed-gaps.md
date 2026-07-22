# TASK 138 — leftover uncalled symbols: three PIN flows with no UI and no disclosure, and two dead settings-model functions

**Status:** todo
**Priority:** LOW — the cleanup tail of the 2026-07-22 sweep. Each is either dead-by-design (delete it, say so) or an undisclosed missing screen (disclose it or build it). Filed so the next sweep skips cleared ground.
**Depends on:** 131 (item 3 covers the settings model overlap), 130
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA test-honesty sweep, 2026-07-22.

## Items
1. **`pin-flows.ts#setFirstPin` / `changePin` / `resetPin` / `clearPinLockoutFlow` have no mobile callers.** `setFirstPin` is disclosed at `bootstrap/session.ts:22`; **change PIN, owner reset, and clear lockout have no UI and no disclosure anywhere.** Decide per flow: build the screen, or record the gap in `roadmap.md` as deferred with a reason. Do not leave an undisclosed dead security flow.
2. **`screens/settings/model.ts#changeLocale` / `#setMuted` — zero callers**; `Root`/`SettingsScreen` do the equivalent inline. `setMuted` is dead by design after task 59's Android ruling. Delete both (and, per task 131 item 3, the superseded model + its green-guarding test) or state why they survive.
3. **`SessionManager.setIdleLockSeconds` has no caller**, so a tenant's configured lock interval never reaches a device. Moot while task 133 stands; becomes live the moment 133 lands — **fold it into 133** rather than fixing here.
4. **CONFIRMED, no longer a hypothesis** (orchestrator traced it, 2026-07-22): **the per-user locale operation is never emitted.** 07-i18n §1.1 gives each USER a locale preference carried by a `platform.setLocale` op. Repo-wide, excluding tests and `dist`:
   - `SetLocalePreference` appears at exactly three sites, all in `apps/mobile/src/screens/settings/model.ts` — the **type** (`:91`), a field typed `SetLocalePreference | null` (`:105`), and a comment (`:110`). **No implementation, no provider, no caller.**
   - Every live `setLocale` is device-local: `i18n.ts:80` (i18next) and `Root.tsx:159/286/452` (a React `useState` setter of the same name — note the name collision, which is part of why this reads as wired). `web/gallery.tsx` likewise.
   - The comments say "task 25 wires it" (`i18n.ts:18`, `model.ts:82-84`) and **task 25 is `done`** — so this is a `mention is not a producer` case (T-16) where the citation outlived the plan.
   **Consequence:** a user's locale choice lives only on the device that made it; it does not follow the user to another device, and no op records it. Decide: implement the op (a new op type is a CLAUDE.md §6 red flag — needs an owner ruling) or record in `roadmap.md` that per-user locale is device-local in v0 and amend 07-i18n §1.1 so the spec stops describing a mechanism that does not exist.

## Note — cleared, do not re-sweep
`media/capture.ts#createExpoCameraCapture`, `CaptureScreen`, `SignaturePadScreen`, `MediaClient.capturePhoto/captureSignature` are reachable only from the visual harness — **honestly disclosed** at `media/client.ts:24` and `index.ts:275`, and `UNWIRED_NOTES_MEDIA.capturePhoto` *rejects* rather than faking a cancel. Tracked by task 130, not a hidden defect.
