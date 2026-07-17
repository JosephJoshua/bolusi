# TASK 80 — iOS is a declared platform that nothing verifies: audit every platform-conditional claim and state which leg is covered

**Status:** done
**Priority:** **HIGH — owner directive (D17)**. Not a build task; an **audit**. It exists because merged, reviewed, green code makes platform claims that were reasoned Android-first, and iOS is now first-class.
**Depends on:** —
**Blocks:** the frontend phase (deferred), task 27's device lanes
**SEC ids owned by THIS task:** none — but it will likely find that `SEC-DEV-08`'s scope needs an explicit iOS statement.

## Outcome (2026-07-16) — the parity table, the SEC ruling, and five filed gaps

**Filed: 83, 84, 85, 86, 87.** Next-free was re-checked across **every ref, at the moment of filing** (not from `_index.md` alone, which shows max 80): `79` and `82` are live on `integrate/18`, `81` on `task/73-testcontainers-real-pg`. Max was **82**; this task took **83–87**. *(Related drift, unfixed here: D17 §Consequences says the audit was "filed as task 79" — but 79 is now `79-media-immutable-hash-comparison-has-no-endpoint.md`. Anyone following D17's pointer lands on a media task.)*

### 1. Three premises this task was given, checked and **refuted**

The brief and this file both asserted things that the repo disagrees with. Recording them because the audit's own framing turned out to carry the class it audits (T-16: a mention is not a producer — *before* declaring something unshipped as well as after).

| the claim | what is actually true |
| --------- | --------------------- |
| *"`keychainAccessible` … **Zero tests**"* (this file, line 23) | **False.** `keystore.test.ts` has 10 tests, **2 of which assert `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` reaches SecureStore on every read/write/delete of both credentials**, and task 58 falsified them (*"dropped `keychainAccessible` from OPTIONS → both options tests red"*). The honest gap is narrower and different: the option's **presence in the call** is asserted; its **effect on iOS** is not, and cannot be here — the suite mocks `expo-secure-store`, which its own header says. |
| *"a SEC id reads as a platform-neutral guarantee it does not deliver"* | **False for `SEC-DEV-08`.** Its row (`security-guide.md:222`) claims *"auto-backup exclusion is present in the shipped **Android** build"* and its evidence column already says *"**Scope, explicitly: this is the BUILD-ARTIFACT leg only**… The on-device restore leg is unclaimed"*. It names its platform. See §2. |
| *"every test, guard, and residual-risk statement covers Android alone"* | **True — but they mostly say so.** `design-system.md:362` says "**Android** hardware back", `testing-guide.md:97` says "physical … **Android** unit", `§6.2:194` says "**Android** auto-backup". **iOS is not mis-claimed; it is absent.** That is a different bug with a different fix, and it is why nothing here is a matter of deleting an overclaim. |

**The one place the platform-neutral reading is real** is the level above all of them: `platforms: ['android', 'ios']`, `z.enum(['android','ios'])` on the enrolment wire (`api/02-auth:125`), `platform … CHECK (platform IN ('android','ios'))` in the DB (`10-db-schema:518`), and `index.ts`'s `Platform.OS === 'ios' ? 'ios' : 'android'`. **A declared, typed, stored, end-to-end iOS path that no layer can produce a binary for.**

**And one nuance that matters for the owner, checked in Expo's config docs:** `platforms` *"Defines the platforms explicitly supported by the project. **Defaults to iOS and Android**"* — so `platforms: ['android', 'ios']` is **the default set, restated**. D17's honest note says *"the declaration was always there"*, which is true; what the audit adds is that **the declaration was never a decision.** Nobody chose iOS and failed to verify it — the line records Expo's default, and the *first* deliberate platform ruling this project will ever make is task 85's. That reframes the finding from "we broke a promise" to "we inherited one", and it is the strongest argument for 85's third option (say v0 is Android-only, out loud) being a real answer rather than a retreat.

### 2. THE TABLE — claim → Android leg → iOS leg → verified?

| # | claim | Android leg | iOS leg | verified? |
| - | ----- | ----------- | ------- | --------- |
| 1 | **§7.4** "a device identity is never resurrected" — **seed + device token** | Keystore wrapping key is hardware-bound, never backed up → restored ciphertext inert; `getItemAsync` returns `null` → clean re-enrol (verified from expo-secure-store's Android source, 58) | `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`. **Genuinely load-bearing** — Expo's documented default is `WHEN_UNLOCKED`, which *does* migrate to new hardware | **Android: yes** (artifact + source). **iOS: call asserted, effect NOT.** No test can see it (module mocked); no target to run it on |
| 2 | **§7.4** — **the SQLCipher DB file** (`bolusi.db`) | excluded from `<cloud-backup>` **and** `<device-transfer>`, 12+ and pre-12; asserted on the generated manifest + falsified (SEC-DEV-08) | **NOTHING.** Artifact-verified: `ios.entitlements: null`, `ios.infoPlist: null`. No `isExcludedFromBackupKey`, no `NSFileProtection` | **Android: yes. iOS: no leg exists.** → **84** |
| 3 | **`SEC-DEV-08`** "auto-backup exclusion present in the shipped Android build" | 3 tests on the generated manifest, all falsified (58) | none — **and correctly not claimed**; the row says "Android" | **Android: yes. iOS: not claimed.** Gap is §6 having no iOS row at all → **84** |
| 4 | **App identity** (bundle id / package) | `android.package: 'com.bolusi.app'`, explicit | **no `ios` block** → real prebuild synthesizes **`com.placeholder.appid`**, silently | **Android: set. iOS: actively WRONG** → **83** |
| 5 | **`api/04-push §5`** per-category muting | channel importance — **impossible** (immutable post-creation); `applyChannelImportance` 0 callers (task 59) | **no channels at all.** `setNotificationChannelAsync.ts` (`@platform android`) logs a debug line and returns `null`; no `.ios.ts` variant, no `Channel` source in the package's `ios/` | **Neither.** Android known-broken (59, owner decision); iOS has no mechanism → **iOS dimension added to 59** |
| 6 | **`design-system §8.1`** hardware back | `BackHandler` real; `useHardwareBack` + `zone.ts`'s `backTarget` tested | `BackHandler.ios.js` is a stub — `addEventListener` returns `{remove: emptyFunction}`, handler never fires | **Android: yes. iOS: N/A and correctly scoped** — the doc already says "Android hardware back". **No gap; no task filed.** |
| 7 | **Build / delivery lane** | 4 EAS profiles, `android.buildType: apk`, asserted + denominator-checked (`eas-profiles.test.ts`) | **no `ios` key in any profile — and `08 §5.5` specifies "Android APK" for all four**, so `eas.json` is spec-correct | **Android: yes. iOS: no lane exists** → **85** |
| 8 | **Device / perf gates** (`testing-guide` Part C, D12/D13, task 27) | "physical 2GB **Android**"; 27a emulator lane, 27b blocked | not mentioned anywhere; no iPhone, **no macOS, no Simulator** | **Neither** (27b blocked). iOS gap not even recorded → **86** |
| 9 | **`userInterfaceStyle: 'light'`** | inert — `expo-system-ui` not installed (task 64) | same | **Neither** — already owned by **64**, cross-platform, not an iOS gap. *(Corroborated in passing: my own prebuild run printed `» android: userInterfaceStyle: Install expo-system-ui in your project to enable this feature.` — task 64's finding, live.)* |
| 10 | **Location permission** — `Root.tsx:89` calls `startLocationWatcher()` at every boot | generated manifest carries `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` — **by accident**, via Android's library-manifest merging from autolinked `expo-location`; the config plugin is **not registered** | **`ios.infoPlist: null`** — no `NSLocationWhenInUseUsageDescription`. iOS has no manifest-merging equivalent; the key comes only from the unregistered plugin | **Android: yes, unintentionally. iOS: absent, and the code requests the permission at boot.** Apple documents termination — **unverified, no target** → **87** |
| 11 | **Camera / mic permission** (task 82's capture, in flight) | `CAMERA` + `RECORD_AUDIO` already in the generated manifest via the same merging from autolinked `expo-camera` (also not in `plugins`) | no `NSCameraUsageDescription` / `NSMicrophoneUsageDescription` | **Android: yes, unintentionally. iOS: absent** — not yet live (82 hasn't built capture) → folded into **87**'s denominator guard |

### 3. `SEC-DEV-08`'s scope — the ruling: **leave it Android-scoped. Do not extend it.**

The brief offered two options: extend `SEC-DEV-08` with an iOS leg, or state in the SEC row that iOS is uncovered. **Neither, as posed** — because the row is *already* platform-scoped and does not overclaim (§1 above).

**Reasoning:** task 31's rule is that a verbatim-id title **retires** an id. One id spanning two platforms would let the green Android leg mark the whole guarantee shipped while iOS is unbuilt — **precisely the failure task 58 scoped around** when it refused to define the id as "a restored backup yields no usable identity". Extending it would *undo* that care, which the brief explicitly asked me not to do.

**The gap is one level up and it is an absence:** `security-guide §6` has no iOS row, no iOS column, and no sentence saying its checklist is Android-only. A reader asking "is this app's data excluded from backup?" finds a **checked** box (§6.2:194) that answers for Android only. That is D17 §Consequences' actual ask, and it is filed as **84** — which also rules **not** to mint `SEC-DEV-09` until the iOS leg has a producer and a falsified guard, because an id whose title precedes its producer is this repo's most-repeated failure (31, 54, 61).

### 4. The device gap, stated precisely (D12/D13's honesty clause, doubled — and the two halves are NOT the same size)

> There is no physical Android on this project (D12/D13) and no physical iPhone. **Calling both "no device" understates the iOS half.** For Android an emulator exists and runs the shipping APK's own Hermes 0.17 (D13), so a real subset of claims is honestly answerable today (task 27a); D12's care is about *performance* numbers an emulator cannot produce. **For iOS there is no runnable target of any kind in this environment:** the host is Linux x86_64 with no `xcrun`/`xcodebuild`, all 10 CI jobs are `ubuntu-latest`, and an iOS Simulator requires macOS. iOS is therefore not "unverified on device" — it is **unverified on every target, including the one a reader would assume substitutes.**

**On the Simulator claim specifically — checked before repeating, per the brief.** Two things are sourced and sufficient: (a) the claim under test is *"the entry is excluded from an encrypted backup/restore"*, and a Simulator has no iCloud/Finder device-backup path to restore **from**; (b) Expo's own SecureStore docs document a Keychain divergence — *"This library requires a real device for testing since emulators/simulators do not require biometric authentication when retrieving secrets, unlike real iOS devices."* **NOT verified, and therefore not repeated:** the common assertion that an iOS Simulator "shares the host filesystem". The brief passed it to me as fact; I could not source it, so it is not load-bearing anywhere in this audit or in 83–87.

### 5. TWO live defects, flagged loudly — filed (83, 87), not fixed

**`app.config.ts` has no `ios` block, and the real prebuild pipeline does not error — it invents an identity.** Produced, not inferred, using the same faithful pipeline `test/android-backup.test.ts` uses (`getPrebuildConfigAsync`, the exact copy real `expo prebuild` loads):

```
ios.bundleIdentifier : "com.placeholder.appid"
android.package      : "com.bolusi.app"
ios.entitlements     : null
ios.infoPlist        : null
```

The producer — `@expo/prebuild-config@57.0.5` → `getPrebuildConfig.js:60-69`:

```js
config.ios.bundleIdentifier = bundleIdentifier ?? config.ios.bundleIdentifier ?? `com.placeholder.appid`;
config.android.package      = packageName      ?? config.android.package      ?? `com.placeholder.appid`;
```

**One fallback, two platforms; the only difference is which platform someone thought about.** Android sets `package` and never reaches the `??`. iOS has no block and takes the placeholder — no error, no warning. **This is T-19's shape (`??` on a failed read is a lie generator) living in upstream Expo**, and the bundle identifier is what scopes the Keychain that holds the seed, the APNs registration, and the App Store identity that cannot be changed after release.

**A second live one, and it is the sharpest thing in the audit — filed as 87.** `expo-location` is a dependency and is **not** in `app.config.ts`'s `plugins`, so its config plugin never runs. Compiling both artifacts side by side:

```
ANDROID generated manifest : ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION  ← present
IOS      ios.infoPlist     : null      (no NSLocationWhenInUseUsageDescription)
```

**Android is fine and nobody arranged it** — Android merges each library's own `AndroidManifest.xml`, so autolinking contributes the permissions whether or not the plugin is registered. **iOS has no Info.plist-merging equivalent**, so the key is simply absent. And `Root.tsx:89` calls `startLocationWatcher()` → `Location.requestForegroundPermissionsAsync()` at **every boot**. Apple documents termination for a protected-resource access with no usage description. **I could not verify the runtime consequence — there is no iOS target (§4) — so 87 records it as documented-and-unverified, not observed.**

This is the audit's thesis in one file, and a **new shape for the collection**: every other finding is *something absent on iOS*; this is *the same config and the same code producing a working Android app and a broken iOS one, because Android silently supplied what the config forgot on both*. There is no Android symptom, so nothing could have noticed. **`app.config.ts`'s `plugins` array is not the app's native config — it is the plugins someone remembered, and Android has been covering the difference.** Task 58's lesson was *the comment was the guard*; this one's is **the other platform was the guard**. `expo-camera` (task 82, in flight) has the identical shape.

**A third, latent, stated precisely rather than inflated:** on iOS `createNotificationChannels` (`Root.tsx:88`, at every boot) awaits a call that returns `null` and **`created.push(id)` regardless** — returning ids for channels that do not exist. **Not user-reachable today**: the return value is discarded and `applyChannelImportance` still has zero callers. It goes live the moment the toggle is wired or the return value is trusted. Added to **59**, not filed separately — 59 already owns that surface and is already an owner decision.

### 6. What moved — nothing, and here are the numbers that say so

This audit shipped **no code and no test**. Every number below was read from the log next to its own `EXIT=` line, never from an exit code or a task-notification (§2.1, T-18):

| gate | result |
| ---- | ------ |
| `pnpm lint` | `EXIT=0` |
| `pnpm typecheck` | `EXIT=0` |
| `pnpm test` | `EXIT=0` — **`Test Files 190 passed (190)`, `Tests 2674 passed | 3 skipped (2677)`**, 0 failures |

**T-18 earned its keep twice here.** (a) The first `pnpm test` was killed by a 10-minute wrapper timeout and returned **exit 143**; the log had **no `EXIT=` line and no `Test Files` line**, so it carried no verdict at all — reporting anything from it would have been a number with fictional provenance. (b) Its partial output was still useful, because it caught the next item.

**A falsification I got for free, on a real change** (§2.11 — watched go red, not asserted): adding the `83`–`86` rows to `_index.md` **before** the task files were git-tracked turned **task 66's ledger gate RED**, with exactly the right message:

```
AssertionError: index rows with no task file: expected [ …(4) ] to deeply equal []
+   "row 83 (status todo) has no task file numbered 83",
+   "row 84 (status todo) has no task file numbered 84",
+   "row 85 (status todo) has no task file numbered 85",
+   "row 86 (status todo) has no task file numbered 86",
```

`git add` the four files → `13 passed (13)`, green. **The gate is load-bearing and its denominator is real**, and the mechanism is worth writing down for the next filer: `collectTrackedTaskFiles` uses `git ls-files`, so a task file that exists on disk but is **untracked** reads to the gate as *absent*. File and stage in one step, or the gate will (correctly) call your row an orphan.

## The directive (D17)

Read **`ai-docs/decisions/2026-07-16-ios-is-a-first-class-target.md`** first — it is an owner directive and the whole premise:

> *"we should also explicitly support iOS properly and beautifully… frontend is later though."*

## The finding this task starts from

**`apps/mobile/app.config.ts` has declared `platforms: ['android', 'ios']` the entire time**, while every test, guard, and residual-risk statement in the repo covers **Android alone**. Nothing lied; nothing verified. **That is this repo's signature failure — a claim nothing checks — operating on the platform list itself.**

Concretely, shipped and merged:

| site | the Android leg | the iOS leg |
| ---- | --------------- | ----------- |
| `keystore.ts` `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` | ruled **inert** by task 58 (iOS-only option, Android-first product), kept + marked `// iOS only:` | **now load-bearing.** It is the mechanism delivering `api/02-auth §7.4` ("a device identity is never resurrected") on iOS. **Zero tests.** |
| `apps/mobile/test/android-backup.test.ts` (**SEC-DEV-08**) | asserts the **generated `AndroidManifest.xml`**, `allowBackup:false`, `<cloud-backup>`/`<device-transfer>` exclusions, resolved `@xml/…` on disk | **no counterpart.** iOS uses `NSFileProtection`, the Keychain accessibility class, and `isExcludedFromBackupKey`. **Nothing asserts any of it**, so a SEC id reads as a platform-neutral guarantee it does not deliver (§2.11). |
| `bootstrap/notifications.ts` + task 59 | the whole muting analysis is **Android channel importance**; the v0 recommendation (drop the in-app toggle, relocate to Android settings) is Android-shaped | **iOS has no channels.** The recommendation may be right for Android and wrong for iOS. |
| task 18's media adapters | `Paths.availableDiskSpace`, `expo-camera`, `expo-file-system`, `FileHandle` chunk reads — residual risk names **Android** only | iOS behaviours differ; the residual-risk sentence is now **incomplete**, not wrong. |
| D12/D13 | "no physical Android" | presumably **no physical iPhone either** — the gap doubled and nobody wrote it down. |

## Scope

**In:** an audit + the filed gaps. Find every platform-conditional claim (code, comment, test, spec, SEC row, residual-risk sentence) and produce a table: **claim → Android leg → iOS leg → verified?**

**Out:** building the iOS legs (each becomes its own task), any frontend/UI work (deferred), buying devices.

## Docs to read

- **D17** (above) — the directive and the five things it rules. **The `impeccable` skill is now installed** (`github.com/pbakaus/impeccable`, v3.9.1) alongside `frontend-design`; both are **mandatory for the frontend phase**, which this task does not do.
- `ai-docs/decisions/2026-07-15-no-device-v0-exit.md` (**D12/D13**) — the no-device posture this amends.
- `ai-docs/tasks/58-*.md` §Outcome — **read it closely.** It is the model for this work: it verified a platform claim against **live SDK docs**, found the option iOS-only, and ruled it inert *because the product was Android-first*. **D17 changes that premise.** Its reasoning is preserved, which is why the ruling can be re-evaluated rather than re-derived.
- `ai-docs/tasks/59-*.md` — the muting analysis, Android-reasoned, **already batched as an owner decision**; D17 adds a dimension to that decision.
- `ai-docs/security-guide.md` §6 — reads platform-neutral, is Android-only.
- `ai-docs/08-stack-and-repo.md` §2.2 (the Expo/RN stack + its platform notes).
- `ai-docs/testing-guide.md` **T-14f** (*"typed and compiling" is not "running on the target"* — now **targets**, plural), **T-15** (the well-typed no-op; `keychainAccessible` was its founding instance), T-16, T-12.

## Acceptance

**Observable done-condition:** a written table of every platform-conditional claim with its per-platform verification status, and a filed task for each uncovered leg. **No claim in the repo reads as platform-neutral while being verified on one platform.**

- **Trace to producers, do not grep for platform names** (T-16 — this repo's most-repeated failure, five instances by the orchestrator alone). A claim's platform-dependence usually is **not** spelled out: `keychainAccessible` looks platform-neutral in TypeScript and is iOS-only in Expo's docs; `getFreeDiskStorageAsync` **throws at runtime** on SDK 54+ while typechecking fine. **Check each API's platform column in current SDK docs via Context7**, not recall, not the symbol's existence.
- **Start with the security surfaces** (§2.5): `keystore.ts`, the backup exclusion (`SEC-DEV-08`), the `§7.4` never-resurrected guarantee. A security control verified on one of two shipped platforms is the highest-consequence instance of the class.
- **`SEC-DEV-08`'s scope is the first decision.** Either extend it with an iOS leg, or **state in the SEC row that iOS is uncovered**. What it may not do is keep reading as a platform-neutral guarantee (task 58 was careful to scope it to the build artifact for exactly this reason — extend that care, don't undo it).
- **The `// iOS only:` marks task 58 left are your map.** They were written to stop a future reader deleting a line that looked dead. They now mark **load-bearing, untested** code. That is the inversion worth reporting.
- **State the device gap precisely** (D12/D13's honesty clause, doubled): every "unverified on-device" sentence must name **which** device. "No physical Android" and "no physical iPhone" are different unverified claims, and a simulator is not a device (an iOS Simulator shares the host's filesystem and Keychain semantics differ — **verify that claim before repeating it**).
- **Do not build the legs here.** File each as its own task with next-free at the moment of filing (six collisions this session; task 66's gate now catches them; `pnpm task:status` is the only sanctioned way to set a Status — CLAUDE.md §5).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green — an audit should move none of them; if it does, say why (§2.1: read the output, not the exit code).

## Note

The instructive part is **why this was invisible**, and it is not carelessness. Task 58 did excellent work: it verified `keychainAccessible` against live docs, found it iOS-only, and correctly ruled it inert **on an Android-first product** — then kept the line and marked it, precisely so a future reader wouldn't delete something load-bearing on a platform they weren't thinking about. Every step was right. **The conclusion was contingent on a premise the owner has now changed.**

That is the argument for how this repo records decisions: task 58 wrote down *why*, not just *what*, so D17 could re-evaluate it in minutes instead of rediscovering the mechanism. A conclusion without its premise is unmaintainable — you cannot tell what would change it. Worth carrying: **when a ruling depends on a product premise (platform, scale, user), name the premise in the ruling.** The premise is an owner's to change, and the ruling should fail loudly when it does — not sit quietly being wrong.
