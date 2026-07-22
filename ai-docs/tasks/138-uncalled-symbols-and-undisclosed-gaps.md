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

5. **Three dead exports in the auth middleware, surfaced 2026-07-22 when task 137 Half B fixed `apps/server`'s knip entry** (that workspace had had *no* production entry, so its exports were never swept). Traced by the orchestrator:
   - **`DEVICE_TOKEN_PREFIX = 'bdt_'` and `CONTROL_TOKEN_PREFIX = 'bcs_'`** (`apps/server/src/middleware/auth.ts:19-20`) are referenced **nowhere** — not in production, not in tests. The format that actually ships lives in `apps/server/src/crypto/index.ts:22`, `mintToken(prefix: 'bdt_' | 'bcs_')`, whose two call sites pass **string literals** (`control-sessions.ts:25`, `routes/devices.ts:226`). So the rule is declared twice: once load-bearing (the union type + literals) and once decorative. Editing the constant changes nothing, which is the trap — a reader who greps for `DEVICE_TOKEN_PREFIX` and edits it would believe they had changed the token format. Delete the constants, or make `mintToken` consume them.
   - **`emptyTokenStore`** (`:53`) — exported, referenced nowhere.
   - **`InMemoryTokenStore`** is NOT in this class: `apps/server/test/helpers/app.ts` and `test-support.ts` use it, and it is a documented test-only seam. Leave it.
   - **A false comment beside them.** `middleware/auth.ts:2` says the bearer slot "carries one of two token kinds **by prefix**". `auth/verify-token.ts:31,43` does **no** prefix discrimination — it tries `findDeviceByTokenHash`, then `findControlSessionByTokenHash`. The *behaviour* is fine (arguably safer than trusting a client-supplied prefix, and hash lookups cannot cross-match), but the comment describes a mechanism that does not exist. Fix the comment to say what the code does.
   - **Checked and CLEARED, so nobody re-files it:** the spec's prefix rule (api/02-auth §474 "prefixed for secret-scanner friendliness") **is** enforced — `apps/server/test/identity/roundtrip.test.ts:38,65` assert a minted `controlSession` starts with `bcs_` and a minted `deviceToken` with `bdt_`. My first hypothesis was that the prefix was unenforced; it was wrong, and tracing it took one grep.
