# TASK 84 — `security-guide §6` never says it is Android-only, and iOS's `§7.4` legs do not exist: the SQLCipher DB restores from an iCloud backup while its key does not

**Status:** in-review
**Priority:** **HIGH** — a security guarantee (`api/02-auth §7.4`) with a built, guarded, falsified leg on one shipped platform and **no leg at all** on the other, which D17 made first-class.
**Depends on:** 83 (the Keychain and the file-protection controls are scoped to a bundle identifier that is currently a placeholder), 85 (nothing here is verifiable until iOS can be built)
**SEC ids owned by THIS task:** **none yet — deliberately.** See §The SEC scope ruling.
**Filed by:** task 80 (iOS parity audit), 2026-07-16, under **D17**.

## Outcome (2026-07-17) — the `isExcludedFromBackupKey` premise does not survive Apple's docs; shipped the §6 statement, no fake control, no SEC id

**The brief's docs-to-read said: *"If the semantics have moved, the premise moved — stop and report."* They did. Verified against Apple's own docs (via Context7 + Apple Developer / QA1719), the artifact-level control this task was scoped to build does not exist:**

- **`isExcludedFromBackupKey` is RUNTIME-ONLY and ADVISORY.** Apple: set via `URL.setResourceValues(_:)` **after the file exists** — there is **no Info.plist / entitlements form** — and *"it's not a mechanism to guarantee those items never appear in a backup or on a restored device."* So there is **nothing to assert in the generated Info.plist/entitlements** (the acceptance's literal ask is unsatisfiable for iOS), and no iOS target here to set or observe it.
- **`NSFileProtection` is not backup exclusion.** The `com.apple.developer.default-data-protection` entitlement's background-safe value (`NSFileProtectionCompleteUntilFirstUserAuthentication`) is already the OS default → declaring it is a well-typed no-op (T-15); `NSFileProtectionComplete` breaks background sync (`expo-background-task`) and Apple advises against the entitlement for background apps. Shipping it as a "backup control" would be a false-assurance artifact (§2.11). **Considered and rejected — recorded so it is not re-derived.**

So there is **no honest artifact-level iOS backup-exclusion guard to ship**, and therefore **no SEC id** (the ruling held: no id without a falsified producer; SEC-DEV-08 stays Android-scoped, no `SEC-DEV-09`).

**What shipped (spec-only, its own commit — CLAUDE.md §4):** `security-guide §6.6` + a new §6.2 checklist bullet, stating explicitly that the backup-exclusion checklist is **Android-only**, that iOS is uncovered and why (the two bullets above), what **does** hold on iOS (`keychainAccessible: THIS_DEVICE_ONLY` — the §7.4 leg, confirmed present in `ports/keystore.ts` + `ports/db-keystore.ts`, asserted in `keystore.test.ts`), and the premises the ruling rests on.

**The open question — ANSWERED from source (T-11), and it is a P1 (task 84's flagged second finding):** on an iOS restore-to-new-hardware, `bolusi.db` **restores** (unexcludable) while `db_encryption_key` does **not** (THIS_DEVICE_ONLY). Bootstrap reads no key → `SecureStoreDbKeyStore.ensureDatabaseEncryptionKey()` **mints a fresh key** → `openClientDb` opens the restored old-key file with the new key → SQLCipher throws `not_a_database` (`driver.ts` maps `file is not a database`) → `Root.tsx`'s `boot()` (deliberately not wrapped in try/catch) leaves `app === null` → **renders nothing, permanently, no recovery path.** Android is not exposed (task 58 excludes the DB, so a restored device has no file → clean re-enrol). The customer is a phone-repair franchise; restore is near the median device event. **Reported to the orchestrator (not filed as a numbered task — the 9x space is actively contended across branches; the finding is durably recorded here + in §6.6).** The fix is the bootstrap error surface (catch `not_a_database`/`missing_key` → wipe + re-enrol) owed to **task 27a**, not this backup control.

**Premise named (per the §Note):** this rests on (1) Android-first history, (2) every record server-synced so nothing local is worth restoring (re-enrol + re-pull is the intended recovery), (3) the franchise wipe/restore/hand-me-down lifecycle, (4) no iOS runnable target here (task 85). If (2) or (4) change, the runtime `isExcludedFromBackupKey` call + the boot recovery path become the producer, and only then does an iOS SEC id earn its place.

**Residual risk (D12/D13 doubled, per D18 §3), in the required words:** the §7.4 iOS leg (`keychainAccessible`) is verified present in source and its call asserted; that a real iCloud/Finder restore behaves as reasoned is **unverified on a real iPhone — no iOS hardware or Simulator exists on this infrastructure** (task 85). No green here is a device-verified restore.

## The SEC scope ruling (task 80's first decision — read before touching `security-guide`)

**`SEC-DEV-08` stays exactly as it is: Android-scoped, build-artifact-only. Do not extend it with an iOS leg.**

D17 and task 80's brief both frame this as *"a SEC id reads as a platform-neutral guarantee it does not deliver"*. **Checked against the row itself, that premise is refuted.** `security-guide.md:222` reads:

> `| SEC-DEV-08 | auto-backup exclusion is present in the shipped **Android** build | …`

It names its platform, in its claim column, and its evidence column already says *"**Scope, explicitly: this is the BUILD-ARTIFACT leg only.** … The on-device restore leg is unclaimed"*. **Task 58 was more careful than it has been credited for.** The id does not overclaim, and extending it would *undo* that care: task 31's rule is that a verbatim-id title **retires** an id, so one id spanning two platforms would let the green Android leg mark the whole thing shipped while iOS is unbuilt — the precise failure task 58 scoped around.

**The real gap is one level up, and it is an absence, not a mis-claim:** `security-guide §6` has **no iOS row, no iOS column, and no sentence saying its checklist is Android-only.** A reader asking *"is this app's data excluded from backup?"* finds a **checked** box at §6.2:194 that answers only for Android, and nothing anywhere states iOS is uncovered. D17 §Consequences asks for exactly this: *"**`security-guide` §6** needs an iOS column, or an explicit statement that its checklist is Android-only — currently it reads as platform-neutral and is not."*

**And do not mint `SEC-DEV-09` as part of the doc change.** An id whose title exists before its producer does is this repo's most-repeated failure (tasks 31, 54, 61). The iOS leg gets an id **when it has a producer and a falsified guard**, in the same commit, and not before.

## The finding — what iOS actually lacks, artifact-verified

Task 80 ran the real prebuild pipeline for iOS (`getPrebuildConfigAsync`, `platforms: ['ios']`) over the shipping `app.config.ts`:

```
ios.entitlements : null
ios.infoPlist    : null
```

So, per platform, for `api/02-auth §7.4` ("a device identity is never resurrected"):

| credential | Android leg | iOS leg |
| ---------- | ----------- | ------- |
| Ed25519 seed + device token (SecureStore) | Keystore wrapping key is hardware-bound and never backed up → restored ciphertext is inert; `getItemAsync` returns `null` and re-enrolls (verified from expo-secure-store's Android source, task 58). Backup exclusion asserted on the generated manifest, falsified (SEC-DEV-08) | `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`. **Correct and load-bearing** — Expo's default is `WHEN_UNLOCKED`, which *does* migrate to new hardware, so without this option §7.4 would be violated on iOS. **The option's presence in the call is asserted** (`keystore.test.ts`, 2 tests, falsified by task 58). **Its effect is unverified and unverifiable here** — the suite mocks `expo-secure-store`, so it asserts this module's contract, never SecureStore's behaviour |
| **the SQLCipher DB file (`bolusi.db`)** | excluded from `<cloud-backup>` **and** `<device-transfer>`, pre-12 and 12+, because the rules `<include>` only `sharedpref` and Android backs up "only the files specified" once any include is present. Asserted + falsified | **NOTHING.** No `isExcludedFromBackupKey`, no `NSFileProtection`, entitlements and infoPlist both null |

**The DB row is the live consequence, and it is the exact mess task 58 removed on Android.** On iOS, `bolusi.db` sits in the app container and **is** included in an iCloud/Finder backup by default. Its `db_encryption_key` lives in the Keychain under `THIS_DEVICE_ONLY` and therefore **is not** restored. So an iOS restore to new hardware yields: **the DB file present, its key gone, the app unable to open its own database.** `security-guide §6.2:194` names this outcome in its own words on the Android side — *"exclusion removes the ambiguity"* — and the ambiguity is live and unaddressed on iOS.

Note this is **not** symmetric with Android. Android's `getItemAsync` returns `null` and the device re-enrolls cleanly (task 58's answered open question). iOS's failure mode is a **file that restores without its key**, which is a different question with a different answer, and nobody has asked it.

## Scope

**In:** (1) the `security-guide §6` statement — an iOS column or an explicit "this checklist is Android-only, the iOS legs are uncovered" line; (2) the iOS backup-exclusion control (`isExcludedFromBackupKey` on the DB + an `NSFileProtection` decision) and its artifact-level guard; (3) an id for the iOS leg **once (2) has a falsified producer**.

**Out:** extending `SEC-DEV-08` (ruled above). The bundle identifier (task 83). The build lane (task 85). Any on-device claim (see §The honesty clause).

## Docs to read

- `ai-docs/decisions/2026-07-16-ios-is-a-first-class-target.md` (**D17** — the premise).
- `ai-docs/tasks/58-*.md` §Outcome — **the model.** Especially why the id is scoped to the artifact and why the guard reads the *generated* manifest.
- `ai-docs/tasks/80-*.md` §Outcome — the full parity table and the device-gap statement.
- `security-guide.md` §6.2:194, §6.5's table (row `SEC-DEV-08`, `security-guide.md:222`).
- `api/02-auth.md` §7.3, §7.4.
- **Apple's own docs, via Context7 — do not trust this file's quotes** (§2.1). Specifically: `isExcludedFromBackupKey` semantics, the `NSFileProtection` classes, and whether `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` items are excluded from encrypted backups. **If the semantics have moved, the premise moved — stop and report.**
- `testing-guide.md` T-14 (a guard asserts its own coverage), **T-14f**, **T-15**, T-16, T-19.

## Acceptance

- **The §6 statement lands first**, and it is cheap: §6 must not read as a platform-neutral checklist while being Android-only. This is a **spec change and therefore its own commit** (CLAUDE.md §4).
- **THE GUARD IS THE DELIVERABLE** for the control. Assert the **generated** iOS artifact (`getPrebuildConfigAsync` + `compileModsAsync` with `platforms: ['ios']`), never `app.config.ts` — task 58's `getConfig`-vs-`getPrebuildConfigAsync` bug is documented in `58 §Outcome` and will bite identically here.
- **Falsify it**: remove the exclusion → observe the specific failure; restore → green. **Report the falsification**, never "the test passes".
- **Answer the open question the way task 58 answered its own** (T-11), from source or Apple's docs, not a guess: **on an iOS restore-to-new-hardware, what does the app do when `bolusi.db` is present and `db_encryption_key` is gone?** Does op-sqlite/SQLCipher throw, or report "not a database"? If it bricks bootstrap with no recovery path, **that is a second finding and it is P1** — the customer is a phone-repair franchise (`58`: restoring a phone is what these people do for a living).
- **The honesty clause (D12/D13 as amended by D17 §3 — and read task 80's device-gap statement before writing yours):** there is no physical iPhone, **and no macOS host, no Xcode, and therefore no Simulator lane either**; all 10 CI jobs are `ubuntu-latest`. The residual risk goes in the Outcome naming **which** target: *"the exclusion is present in the generated iOS artifact; that it behaves as documented on a real iCloud or Finder restore is unverified on a physical iPhone, and was not attempted on a Simulator because none can run in this environment."* **Do not let a green artifact test imply a device-verified restore, and do not claim a Simulator would substitute** — see task 80 for why it would not.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green. Read the output, not the exit code (§2.1).

## Note

**Name the premise in the ruling.** Task 58's conclusion — `keychainAccessible` is inert — was correct, verified against live docs, and is now wrong, because the owner changed a product premise (`00-product-overview:41`, "Android-first"). It was re-evaluated in minutes instead of re-derived, purely because task 58 wrote down *why* alongside *what*.

So: whatever this task rules about iOS backup exclusion, **name the premise it rests on** — the platform list, the fact that every record is server-synced and nothing local is worth restoring, the franchise's hand-me-down device lifecycle. A conclusion without its premise is unmaintainable: you cannot tell what would change it, so it sits quietly wrong instead of failing loudly.
