# TASK 58 — the keystore's `THIS_DEVICE_ONLY` is an **iOS-only option** on an Android-first product, and the Android control that would do its job is an unchecked box nobody owns

**Status:** todo
**Priority:** **HIGH** — a written security requirement (`security-guide §6.2`) that nothing builds, nothing tests, and no task owns, on **the** most likely device lifecycle event in this business. The code comment asserting the guarantee names a mechanism that does not run on the target platform.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** — (none exist for this surface; see §Acceptance — one of the deliverables is deciding whether one should)

## Goal

Make "a device identity is never resurrected" (`api/02-auth §7.4`, `security-guide §6.1:187`) true **on Android by construction**, and make `keystore.ts` stop claiming it is delivered by an option Android ignores.

## The finding

Three things, one surface, one root question: **what actually enforces §7.4 on Android?**

### 1. `keystore.ts:34` is inert on the target platform

`apps/mobile/src/ports/keystore.ts:33-35`:

```ts
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
```

and `keystore.ts:16-18` explains why:

> `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` is deliberate: … `THIS_DEVICE_ONLY` keeps it out of encrypted backups/restores, **so a device identity is never resurrected onto different hardware (§7.4** — re-enrollment always means a fresh keypair).

**`keychainAccessible` is iOS-only.** Expo's current SDK docs, `SecureStoreOptions`, verbatim:

> **keychainAccessible** (KeychainAccessibilityConstant) — Optional — **Supported platforms: iOS.** Specifies when the stored entry is accessible, using **iOS's `kSecAttrAccessible`** property.

and again under Types:

> The `accessGroup` and `keychainAccessible` properties are **specific to iOS**.

**The trap that hid this:** the *constants* page says `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is *"Supported on Android, iOS, tvOS"* — that describes **the constant existing**, not **the option having an effect**. The symbol resolves, `tsc` is green, the object is well-typed, and on Android the field is dropped on the floor. This is CLAUDE.md §2.11's pattern with **a code comment as the guard**: it cites a spec section and a concrete mechanism, so a reader (or a reviewer) concludes the surface is handled — and stops looking.

Android is not a side platform here. `app.config.ts` says `platforms: ['android', 'ios']`, and the product is 2 GB Android phones (`00-product-overview`). The one line claiming to enforce §7.4 does nothing on the only device that ships.

### 2. The control that WOULD enforce it on Android is written, unchecked, and unowned

`security-guide.md:194` — an **unchecked box**, and it already knows the whole answer:

> - [ ] Android auto-backup excludes the app's data (SQLCipher DB + prefs): `configureAndroidBackup` / backup rules. Keystore-held wrapping keys never back up, so a restored backup without the original device is unreadable anyway — exclusion removes the ambiguity.

**Verified: nothing implements it.** `grep -rniE "allowBackup|data-extraction|dataExtractionRules|device-transfer"` across `apps/` and `ai-docs/` → **no hits outside that one checklist line.** `app.config.ts`'s `android` block is `{ package: 'com.bolusi.app' }` — and per Expo's config docs `allowBackup` **defaults to `true`**.

**Verified: no task owns it.** `grep -rliE "auto-backup|allowBackup|configureAndroidBackup|backup rules" ai-docs/tasks/` → **zero files.** Task 14 owns the keystore and is marked **done**. This is the orphan class the QA sweep was built to find, and it is the first one found in `security-guide`'s own checklist.

### 3. Zero tests (review-05's coverage sweep)

`apps/mobile/src/ports/keystore.ts` has **no test file**. Review-05's summary of line 34: **"If this line silently changed, what would notice? Nothing."** Same enum → `tsc` green, no lint rule, no test. Also untested in the same file: `wipe()` (the `§7.3` crypto-erase), `assertUnder2Kb`, and `getSigningKey()`'s throw.

## What is actually true on Android (do not skip — it changes the fix)

Per Expo's docs, *"On Android, values are stored in **SharedPreferences**, encrypted with Android's Keystore system."* SharedPreferences are in Auto Backup's default set. So today:

| step | what happens on Android |
| ---- | ----------------------- |
| backup | the **ciphertext** of the seed/token goes to Google Drive (`allowBackup` defaults true, nothing excludes it) |
| the wrapping key | stays in Android Keystore — hardware-bound, **never backed up** |
| restore to new hardware | app gets a SharedPreferences entry it **cannot decrypt** |

**So §7.4's security property holds on Android — but not for the reason the comment gives.** The seed is not resurrected because the Keystore key that unwraps it never left the old phone. The `THIS_DEVICE_ONLY` line contributes nothing to that. `security-guide:194` reached this same conclusion already (*"unreadable anyway — exclusion removes the ambiguity"*), which is why it asks for exclusion regardless.

**And that leaves a real, live, non-security bug**, which is the part that should drive priority. Expo's Android 12+ guidance prescribes exactly this exclusion and says why:

```xml
<data-extraction-rules>
  <cloud-backup>
    <include domain="sharedpref" path="."/>
    <exclude domain="sharedpref" path="SecureStore"/>
  </cloud-backup>
  <device-transfer>
    <include domain="sharedpref" path="."/>
    <exclude domain="sharedpref" path="SecureStore"/>
  </device-transfer>
</data-extraction-rules>
```

> This prevents **data decryption issues** after restoration.

A restored device holds undecryptable ciphertext where the app expects either a valid key or nothing. **Which of those two it behaves like is unknown and is this task's first question** — if `getItemAsync` throws rather than returning `null`, bootstrap fails on a restored phone with no recovery path. If it returns `null`, the app reads as unenrolled and re-enrolls, which is §7.4's correct path *by accident*. The same applies to the SQLCipher DB, which §194 names in the same breath: restored DB file + unrecoverable `db_encryption_key` = an app that cannot open its own database.

**Why this is not hypothetical for Bolusi.** The customer is a **phone-repair franchise**. Staff devices are cheap Androids that get wiped, restored, replaced, and hand-me-downed as a matter of routine — restoring a phone is the thing these people do *for a living*. "Restore to new hardware" is not an edge case in this deployment; it is close to the median device event. And the user is tech-inadept and often offline, so "the app won't open after I restored my phone" has no self-service path.

## Docs to read

- `security-guide.md` **§6.2:194** (the unchecked box — this task's primary deliverable) and **§6.1:187** / **§6.2:176** (the claims it backs). Note §6.2's standing rule: *"The spec, code comments, and owner-facing material must not say 'hardware-backed' without this qualification"* — the defect in `keystore.ts:16-18` is that exact rule broken in a different direction (naming a mechanism that isn't running).
- `api/02-auth.md` **§7.4** (re-enrollment; a device identity is never resurrected), **§7.3** (the wipe order), **§3** (the four credentials; `< 2 KB`).
- `apps/mobile/src/ports/keystore.ts` — the whole file; it is 100 lines and its comments are the thing under review.
- `apps/mobile/app.config.ts` — the `android` block; whatever lands goes here or in a config plugin.
- **Expo SecureStore docs — read them yourself via Context7, do not trust this task file's quotes** (§2.1: read the tool's own output). Specifically `SecureStoreOptions` (the platform column) and the Android Auto Backup section. If the platform support has changed since this was filed, **the premise moved — stop and report**, don't build against a stale quote.
- `testing-guide.md` T-11 (reproduce first), T-12 (test the class not the instance), T-14 (a guard asserts its own coverage), **T-14f** (the "both engines ≠ both drivers" shape — this is its cousin: *"typed and compiling" ≠ "running on the target platform"*).
- `CLAUDE.md` §2.11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **No physical Android in this project** (D12/D13) — say what you could not verify on-device rather than implying you did. See §Acceptance's honesty clause; this is the constraint that makes the *config-level* assertion the deliverable rather than a device demo.

## Acceptance

**Observable done-condition:** the Android build excludes SecureStore + the SQLCipher DB from auto-backup and device transfer; a test fails if that exclusion regresses; and `keystore.ts` no longer claims an iOS-only option delivers an Android guarantee.

- **Answer the open question first** (T-11 — it determines whether this is also a P1 crash): what does `SecureStore.getItemAsync` do on Android when the entry exists but the Keystore key is gone (restore-to-new-hardware)? **Throw, or return `null`?** Determine it from Expo/Android source or docs, not from a guess. If it throws, this task also owns the bootstrap path that catches it, and **that is a second finding to report loudly** — a restored phone bricks the app for a user with no recovery path.
- **Land the exclusion** (`security-guide:194`): `data-extraction-rules` (Android 12+) **and** the pre-12 `allowBackup`/backup-rules path — the fleet is cheap Android, so old API levels are the normal case, not the tail. Cover **both** `<cloud-backup>` and `<device-transfer>` (a franchise hand-me-down is a device transfer, not a cloud restore). Name the SQLCipher DB, not just SharedPreferences — §194 says *"SQLCipher DB + prefs"* and the DB has the identical undecryptable-restore problem.
- **THE GUARD IS THE DELIVERABLE** (§2.11/T-14). A config value that is correct today and silently dropped by the next `app.config.ts` edit or plugin bump is this bug again on a delay — and the thing that makes it a *silent* regression is that **there is no runtime symptom on the dev's machine**. Ship a check that reads the **generated** manifest/config (the artifact that ships, not the source that hopes) and fails when the exclusion is absent. **Falsify it**: remove the exclusion → red; restore → green. **Report the falsification**, not "the test passes."
  - **Know which artifact answered** (T-14d's shape, and the trap here): asserting on `app.config.ts` proves you can read your own source file. The claim is about `AndroidManifest.xml` / the extraction-rules XML **after prebuild**. If your guard cannot tell those apart, it is checking nothing — and its failure mode is *silently checking nothing*, which §2.11 rates worse than no guard.
- **Fix the comment, and fix it in the honest direction.** `keystore.ts:16-18` must not credit `THIS_DEVICE_ONLY` with §7.4 on Android. State what actually holds: Android Keystore's wrapping key is hardware-bound and never backed up, so restored ciphertext is inert; the option is iOS's leg of the same property; the backup exclusion removes the ambiguity and prevents the decryption-failure mess. **Do not simply delete the option** — it is correct and load-bearing *on iOS*, which is a listed platform. Mark it `// iOS only:` so the next reader doesn't re-derive this.
- **Then test the file** (review-05's half). `vi.mock('expo-secure-store')` — no device needed. At minimum: `wipe()` deletes both keys **and** clears the in-memory `#signingKey` (§7.3 crypto-erase — an in-memory seed surviving a wipe defeats it); `assertUnder2Kb` throws at the boundary; `getSigningKey()` throws when unloaded rather than returning empty bytes to the signer. **Assert the options object reaching SecureStore**, so an unreviewed change to it fails a test — that is the "what would notice? nothing" hole closed.
- **Sweep the class, don't patch the instance** (T-12): is any **other** iOS-only Expo option set somewhere its comment implies cross-platform effect? `accessGroup` is the sibling named in the same docs sentence. And more broadly: **what else in `apps/mobile` is a platform-conditional no-op that typechecks?** Report what you find; don't fix it here.
- **Decide, and say which** (this is a judgment call, make it explicitly): does this surface deserve a **SEC id** in `security-guide`? `§6.2:194` is currently the only thing carrying an Android-specific control and it is prose in a checkbox — the SEC-META gate (task 31) cannot see it, which is *why* it stayed orphaned through 29 merged tasks. If yes, the id + its owning row is part of this task; ride task 31's declarative rails, do not build a second mechanism (§2.8).
- **Honesty clause** (D12/D13 — no physical Android): you cannot demo a real Google Drive restore. **Say so.** The deliverable is the config assertion + the falsification, and the residual risk — *"the exclusion is present in the shipped manifest; that it behaves as documented on a real restore is unverified on-device"* — goes in the Outcome **in those words**. Do not let a green config test imply a device-verified restore. That inflation is the exact move §2.11 exists to stop.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by review-05's coverage sweep, which asked one question — *"if this line silently changed, what would notice?"* — and answered **"nothing"**. That question is doing something the other sweeps don't: it found a defect **in a file that is 100 lines of careful, well-commented, correct-looking code owned by a task marked `done` and passed by a review**.

Worth carrying, because it is a new shape for this project's collection: **the comment was the guard.** `keystore.ts:16-18` is a good comment — it cites the spec section, names the mechanism, explains the tradeoff, and pre-empts the obvious objection (`requireAuthentication`). It reads like diligence. And it is the reason nobody checked, because it answered the question a reader would have asked. Every prior instance in §2.11 was a *test* that passed without testing; this is **prose that reviewed without reviewing** — and prose is not in any gate's denominator.

The second thing worth carrying is how the platform docs hid it. `WHEN_UNLOCKED_THIS_DEVICE_ONLY` **is** documented as *"Supported on Android, iOS, tvOS"* — on the constants page. The option that takes it is iOS-only, on a different page. Both statements are true; the composition is a trap. **The type system cannot catch this class at all**: the option is well-typed, the constant is exported for every platform, and the field is simply ignored at runtime by one of them. Task 39 found `tsc` silently checking nothing across `apps/server`; this is `tsc` checking *correctly* and the check being **irrelevant** — a well-typed no-op. There is no compiler answer to "does this field do anything on this platform," which is precisely why §194 asks for a **config** control and this task asks for a guard on the **generated manifest**.
