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
4. Hypothesis, not demonstrated: **per-user locale (`platform.setLocale`, 07-i18n §1.1) may never be emitted.** `SettingsDeps.setLocalePreference` is `null` by design and `SetLocalePreference` has no production provider; the comment says "task 25 wires it" and task 25 is `done`. **Trace whether an emitter landed elsewhere before filing this as a defect (T-16 — a mention is not a producer, and it cuts both ways).**

## Note — cleared, do not re-sweep
`media/capture.ts#createExpoCameraCapture`, `CaptureScreen`, `SignaturePadScreen`, `MediaClient.capturePhoto/captureSignature` are reachable only from the visual harness — **honestly disclosed** at `media/client.ts:24` and `index.ts:275`, and `UNWIRED_NOTES_MEDIA.capturePhoto` *rejects* rather than faking a cancel. Tracked by task 130, not a hidden defect.
