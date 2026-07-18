# TASK 91 — iOS restore-to-new-hardware permanently bricks the app: restored DB + non-restored key → wrong-key open → `boot()` renders nothing forever

**Status:** done
**Priority:** **HIGH — a permanent, unrecoverable brick on the target's MEDIAN device event.** The customer is a phone-repair franchise; restoring/replacing a phone is what they do for a living. iOS-triggered, but the fix is platform-neutral defence.
**Depends on:** — (the fix lives in the bootstrap error surface; overlaps task 27a's device bootstrap)
**Blocks:** an iOS launch
**SEC ids owned by THIS task:** none — but it is the runtime consequence of `SEC-DEV-08`'s iOS gap (task 84) meeting the SQLCipher key model (§6.4).

## The finding (impl-ios, tasks 83/84/87; verified from source by the orchestrator)

**On iOS restore-to-new-hardware the app renders nothing, permanently, with no recovery path.** The chain, each link confirmed:

1. **The SQLCipher DB file (`bolusi.db`) IS restored.** iOS backs it up and **cannot exclude it** — task 84 established `isExcludedFromBackupKey` is **runtime-only and advisory** (Apple: *"not a mechanism to guarantee those items never appear in a backup or on a restored device"*), with no build-artifact form. So unlike Android (task 58 excludes the DB by construction), iOS carries the DB across a restore.
2. **The encryption key is NOT restored.** `db-keystore.ts` sets `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so the Keychain item does not migrate to new hardware (that is the §7.4 "never resurrected" property working as intended).
3. **Bootstrap mints a FRESH key.** `ensureDatabaseEncryptionKey` reads null (no restored key) → generates a new one → **opens the restored old-key DB with the new key.**
4. **SQLCipher throws.** `openClientDb` (`connection.ts:151-161`) raises `DbOpenError('not_a_database' | 'missing_key')` on the mismatch.
5. **`boot()` does not catch it, BY DELIBERATE DESIGN.** `Root.tsx:118` — *"Deliberately NOT wrapped in a try/catch that renders the shell anyway"* — so the throw propagates, `setApp` (`:125`) never runs, and `:133` `if (app === null) return null` **renders nothing forever.** No retry, no wipe, no re-enrol.

**The deliberate no-catch is right for its stated purpose and wrong for THIS case.** Not rendering a working-looking shell over a dead data layer is correct (§2.11 — don't fake a green boot). But a **restored device is not a corrupt device** — it is a *fresh* device wearing an old device's ciphertext, and the correct response is to **wipe and re-enrol**, exactly as a factory-reset Android does (§7.4). The stance conflates "the DB is corrupt, fail loudly" with "this hardware isn't the one that made the DB, start clean."

**Android is NOT exposed** (stated so the fix isn't over-scoped): task 58 excludes both the DB and SecureStore from Android backup, so an Android restore returns *neither* → clean re-enrol. iOS is exposed precisely because its backup restores the DB selectively. **This finding exists only because iOS is now first-class (D17/D18) — it was invisible while the product was Android-only.**

## The fix

- **Catch `not_a_database` / `missing_key` at `boot()` and self-heal**: wipe the unreadable DB + the (fresh, useless) key, and drop to the enrolment flow — the device is unenrolled, which is the true state. This is `api/02-auth §7.4`'s re-enrolment path, reached by a different trigger.
- **It is platform-neutral defence even though the trigger is iOS**: any wrong-key/corrupt-DB boot should self-heal rather than brick. Do not gate the catch on `Platform.OS === 'ios'` — gate it on the error.
- **Preserve the deliberate stance for the OTHER failure modes**: a genuinely corrupt DB from disk failure (not a key mismatch) may still warrant loud failure; distinguish `not_a_database`/`missing_key` (heal) from other `DbOpenError` kinds (surface). State which you chose and why.
- **This is the bootstrap error surface owed to task 27a** (device bootstrap / SEC-DEV-06 on-device). Coordinate: 27a may own the harness; this owns the boot-time catch. Do not duplicate.

## Docs to read

- `apps/mobile/src/bootstrap/Root.tsx` (`boot()`, the deliberate-no-catch comment at :118), `db-keystore.ts` (the key model), `packages/db-client/src/connection.ts` (`DbOpenError` kinds, `sanitizeOpenFailure`).
- `security-guide.md` **§6.6** (impl-ios recorded this finding there — read it; it has the Apple-docs citations), §6.4, §7.4.
- `ai-docs/tasks/84-*.md` §Outcome (the iOS backup asymmetry that causes step 1), `ai-docs/tasks/58-*.md` (the Android exclusion that makes Android safe), `ai-docs/tasks/50-*.md` (the bootstrap you extend; its one-connection + key single-flight).
- `ai-docs/decisions/2026-07-16-ios-is-a-first-class-target.md` (D17), `2026-07-17-owner-rulings-muting-218-ios-sync.md` (D18 §3/§5).
- `testing-guide.md` T-11, T-17 (a heal path needs a positive control: a device with the RIGHT key still opens), T-19.

## Acceptance

**Observable done-condition:** a boot that hits a restored old-key DB wipes and re-enrols instead of rendering nothing; a boot with the correct key still opens normally (positive control).

- **Reproduce first** (T-11): open a DB under key A, then boot with key B (simulating the restore) → today the app renders nothing (`app === null`, no throw surfaced to the user). That silent brick is the finding.
- **Falsify the heal** (§2.11): with the catch in place, the wrong-key boot reaches the enrolment screen (not a blank render); **positive control (T-17)**: a correct-key boot still opens the DB and renders the app — prove the catch didn't just swallow every open into a re-enrol loop.
- **Do not brick, do not loop, do not silently wipe good data**: the wipe only fires on the unreadable-DB path; a transient error must not nuke a healthy DB. This is a §2.5-adjacent data-safety surface — a wrong catch that wipes a working DB is worse than the brick.
- **iOS residual risk, required words** (D12/D13 doubled): the heal logic is unit-verified against the `DbOpenError` kinds; that a real iPhone restore produces exactly this sequence is **unverified on-device — no iOS hardware or Simulator exists on this infrastructure** (task 85). State it.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — read the output (§2.1).

## Note

Found by impl-ios **producing the prebuild artifact and reading Apple's own docs** rather than trusting the audit's premise (T-16) — the same pass that refuted two of task 80's premises. It is the sharpest argument yet for D17: **the iOS-first directive did not add a checkbox; it surfaced a permanent-data-loss bug on the customer's most common device event, one that was structurally invisible while the product was Android-only.** The Android backup exclusion (task 58) wasn't just a security nicety — it was silently protecting the boot path from exactly this, and iOS has no equivalent, so the boot path's hidden assumption ("if the DB exists, our key opens it") finally failed.

Worth carrying: `Root.tsx:118`'s comment is *correct* and *well-reasoned* and still wrong for this case — the third time this session an accurate, defensible comment encoded an assumption that a new platform broke (cf. `keystore.ts`'s iOS-only option, `notifications.ts`'s channel rule). A comment states what its author knew; it cannot state what a later premise change will invalidate. **When a comment justifies NOT handling an error, name the cases it is deciding not to handle** — this one said "don't render a fake shell" and silently also decided "don't heal a restored device," which no reader would extract from it.
