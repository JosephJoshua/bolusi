# TASK 148 — the Android APK CANNOT BE ASSEMBLED: op-sqlite (SQLCipher) and react-native-quick-crypto each ship their own `libcrypto.so`, and `:app:mergeReleaseNativeLibs` refuses

**Status:** blocked
**Priority:** **HIGH — nothing Android ships until this is fixed.** There is no APK. Every device- and emulator-gated claim in the repo sits behind this, including task 27a, task 117 (Maestro), and SEC-AUTH-09 leg 1.
**Depends on:** 27a (whose lane surfaced it)
**Blocks:** 27a, 117, 28 (SEC-AUTH-09 leg 1 needs real SQLCipher on the emulator)
**SEC ids owned by THIS task:** none directly — **but the fix touches which OpenSSL build backs SQLCipher and quick-crypto, so it is a security-surface decision, not a packaging nit.** See the warning below.
**Filed by:** the orchestrator, 2026-07-22, from the FIRST-EVER completed run of the Android emulator lane (run 29891270836, job 88832033255).

## The failure, verbatim

```
FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:mergeReleaseNativeLibs'.
> A failure occurred while executing …MergeNativeLibsTask$MergeNativeLibsTaskWorkAction
   > 2 files found with path 'lib/arm64-v8a/libcrypto.so' from inputs:
      - node_modules/.pnpm/@op-engineering+op-sqlite@17.1.2_…
      - node_modules/.pnpm/react-native-quick-crypto@1.1.6_…
     If you are using jniLibs and CMake IMPORTED targets, see
     https://developer.android.com/r/tools/jniLibs-vs-imported-targets
```

Both crypto-bearing native dependencies vendor **their own OpenSSL**: op-sqlite links libcrypto for **SQLCipher** (the at-rest encryption for the entire client DB), quick-crypto links it for **argon2id + Ed25519** (PIN derivation and op signing). Gradle will not silently pick one.

## Why this went unnoticed until 2026-07-22

`08-stack-and-repo.md` §2 predicted this class in the op-sqlite row — *"SQLCipher replaces vanilla SQLite — watch **iOS** duplicate-symbol conflicts if another dep links SQLite"* — and it landed on **Android**, against `libcrypto` rather than `libsqlite`. The prediction was right about the mechanism and wrong about the platform, which is the ordinary way these are missed.

The reason nothing caught it is task **142**: the `android-emulator` job is `schedule || workflow_dispatch`-gated and **had never completed a run**. So the Android app has never been assembled, by anyone, at any point in this repo's life. Everything "Android-first" about this product is, at the build level, unverified.

## The naive fix is a SECURITY decision — do not just do it

The one-line answer is `packagingOptions { pickFirst 'lib/**/libcrypto.so' }`. **That silently makes one library's OpenSSL serve both consumers.** If the two builds differ in version or configuration, the loser gets an OpenSSL it was not linked against — and the two consumers here are *the database encryption* and *the signing/KDF stack*. A mismatch does not necessarily crash; it can degrade or misbehave, which is the worst possible failure mode on this surface.

Before choosing, establish (and write down):
1. **Which OpenSSL each ships** — version and build config, read from the actual `.so`/podspec/CMake in `node_modules`, not from docs.
2. Whether either dependency offers a **supported way to share one libcrypto** (op-sqlite and quick-crypto both have build flags/config blocks; check current docs via Context7 — `08 §2` already pins op-sqlite config through `package.json`'s `op-sqlite` block).
3. If `pickFirst` really is the sanctioned answer for this pair, say **which** one wins and why that is safe for the loser, with a citation.

Also check the **16 KB page-size** requirement for current Android targets while you are in the native config — a second class of native-packaging failure that only an assembling build can reveal.

## FALSIFY (§2.11 — REPORT it)
- **The build itself is the primary evidence:** `:app:assembleRelease` must succeed and produce an APK. Report the task's own output, not a summary.
- After it assembles, **prove both consumers still work on the emulator** — this is the whole risk of the fix. SQLCipher must open an encrypted DB and reject a wrong key; argon2id and Ed25519 must produce the same vectors the Node lane produces. A green build that quietly broke one of them is exactly what `pickFirst` risks, and "it compiled" is not evidence that it works (§2.11: typed and compiling is not running on the target).
- Positive control: confirm the emulator lane FAILS if the APK is missing, rather than skipping to green.

## Note
This unblocks the whole native chain. Task 27a cannot report, 117 cannot drive Maestro, and SEC-AUTH-09 leg 1 cannot be answered until an APK exists.


---

## INVESTIGATION COMPLETE 2026-07-22 — facts established, decision NOT made (boundary respected, nothing committed)

### 1. The two OpenSSL builds — read from the artifacts, not the docs

Neither package vendors a `.so`. Both pull a **prefab AAR from Maven Central published by the same author** (`io.github.ronickg`):

| | op-sqlite 17.1.2 | quick-crypto 1.1.6 |
| --- | --- | --- |
| Declared dep | `io.github.ronickg:openssl:3.3.2-1` (`android/build.gradle:298`, gated on `useSQLCipher`) | `io.github.ronickg:openssl:3.6.2-1` |
| CMake | `find_package(openssl REQUIRED CONFIG)` → `openssl::crypto` only | `openssl::crypto` **and** `openssl::ssl` |
| Version string | `OpenSSL 3.3.2 3 Sep 2024` | `OpenSSL 3.6.2 7 Apr 2026` |
| Hardening flags | `-O3 -DOPENSSL_USE_NODELETE -DOPENSSL_PIC -DNDEBUG -D__ANDROID_API__=21` | same **plus `-fstack-protector-strong`, `-D_FORTIFY_SOURCE=2`** |
| sha256 / size | `f8d880e3…` / 5,755,512 | `022ad291…` / 6,749,656 |
| SONAME | `libcrypto.so` | `libcrypto.so` — **identical, which is the whole problem** |

**Different version AND different build config.** Exported `FUNC` symbols: **399 present in 3.6.2 and absent from 3.3.2; 0 lost the other way.** So the two `pickFirst` branches are not symmetric:

- **Keep op-sqlite's 3.3.2** → quick-crypto breaks **loudly**: its C++ calls `OSSL_PROVIDER_add_conf_parameter` (`cpp/keys/HybridKeyObjectHandle.cpp:31-33`), which does not exist in 3.3.2.
- **Keep quick-crypto's 3.6.2** → every SQLCipher symbol still resolves, so it **loads and runs with no error signal at all**. SQLCipher 4.14.0's only OpenSSL guard is `OPENSSL_VERSION_NUMBER < 0x10100000L`, so nothing checks. **This is the silent-degradation branch, on the database encryption.**

**Which branch you get is decided by AGP's merge input ordering, not by anything in the config.**

*(Investigator's own correction, recorded because it is the right discipline: a first grep also flagged `i2d_PKCS8PrivateKey` and `EVP_PKEY_CTX_set_signature` as missing. Both were **substring false positives** of `…_bio`/`…_md`, which do exist in 3.3.2. Re-run with word boundaries: one real missing symbol.)*

### 2. Is there a supported sharing mechanism? **No.**

- **op-sqlite**: no OpenSSL-sourcing flag exists. Full config key list is `sqlcipher, crsqlite, performanceMode, iosSqlite, sqliteFlags, fts5, rtree, libsql, turso, sqliteVec, tokenizers`. Its docs' only advice is *"On Android you might be able to get away by just using a pickFirst strategy."*
- **quick-crypto**: the Expo plugin exposes only `sodiumEnabled` + Xcode workarounds. No OpenSSL option.
- **This exact collision is upstream [margelo/react-native-quick-crypto#1059](https://github.com/margelo/react-native-quick-crypto/issues/1059), filed 2026-06-13, still OPEN**, and it names op-sqlite+SQLCipher as the trigger. Maintainer `boorad` on 2026-06-16: **`pickFirst`** *"builds but isn't safe: Android's linker is a flat/global namespace, so keeping one `libcrypto.so` leaves the other consumer binding against a build it wasn't compiled against. Crashes/UB are expected. **Not a real fix.**"* Their preferred fix (static-link with hidden visibility) is **not shipped**; the build-flag option was rejected as *"risky for a crypto library."*
- **Both packages are already at `latest`.** No upgrade path; op-sqlite's `main` still pins `3.3.2-1`.

**Version alignment does not rescue the build either.** AGP's `StreamMergeAlgorithms.acceptOnlyOne()` throws `DuplicateRelativeFileException` on any path seen twice **without comparing content**, and each library module packages its prefab into its own `library_jni` output. So even byte-identical copies still require a `pickFirst`. **Every available path routes through the forbidden directive.**

### 3. The 16 KB page-size check — clean where it was checked, but the LANE CANNOT SEE IT

- Targets `compileSdk/targetSdk 36, minSdk 24, NDK 27.1.12297006`. Play requires 16 KB support for API 35+ since 2025-11-01; NDK 27 does not default to it (r28+ does), so the flag is mandatory.
- All four locally-compiled native modules pass `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` (op-sqlite, quick-crypto, nitro-modules, expo-modules-core) — verified by reading each `android/build.gradle`.
- Both OpenSSL AARs are correctly aligned (`readelf -lW` shows `0x4000` LOAD alignment on `arm64-v8a` and `x86_64` in both).
- **Gap:** nothing in the repo verifies alignment (no `zipalign -c -P 16`), and **the emulator lane is `api-level: 34`, which has 4 KB pages.** Google's 16 KB images are API 35+ experimental only. **So the lane structurally cannot catch a 16 KB regression even once it builds.** RN 0.86's own prebuilt libs are unverified.

### 4. THE DECISION — ranked, for the owner (CLAUDE.md §6)

**Recommendation: do not ship a `pickFirst` on this pair.**

1. **Preferred — remove the collision at the source: drop `sqlcipher: true` from op-sqlite and move at-rest DB encryption to a mechanism that does not vendor a second OpenSSL.** The only option that is correct by construction rather than by hope. A real architecture change (`10-db-schema` / `security-guide` own it) and squarely an owner decision. Upstream #1059's reporter confirmed `op-sqlite (sqlcipher: false) + quick-crypto` builds clean.
2. **Wait on / sponsor upstream #1059 Option B** (static-link, hidden visibility) — the maintainer's stated direction, fixes iOS and Android identically, but unshipped with no timeline. Android stays unbuildable until then.
3. **Force `io.github.ronickg:openssl` to `3.6.2-1` across all subprojects, then `pickFirst` the now-identical file.** The least-bad hack, and still a hack: undocumented by both upstreams; makes SQLCipher 4.14.0 run on an OpenSSL its maintainer never pinned; requires patching a security dependency's build file; and **still requires the forbidden directive**. If chosen, the falsification list is non-negotiable and entirely emulator-only: SQLCipher opens an encrypted DB **and rejects a wrong key**; argon2id and Ed25519 reproduce the Node lane's vectors byte-for-byte. **A green `assembleRelease` proves none of that.**
4. **Rejected — plain `pickFirst` at today's versions.** One branch crashes on a missing symbol; the other silently runs the database encryption on an OpenSSL it was not compiled against.

Mechanism if option 3 is chosen: `expo-build-properties` (already installed, 57.0.3) exposes `android.packagingOptions.pickFirst`; forcing the AAR version needs a custom `withProjectBuildGradle` plugin or a `pnpm patch` on op-sqlite.

**No Gradle build was run** (no Android SDK on this host) and no APK was produced. Everything above is read from artifacts, upstream source, and CI logs. **Positive control already satisfied:** run 29891270836's `android-emulator` went RED on the missing APK rather than skipping to green.

### 5. Sibling finding — see task 151
The same investigation found **SQLCipher is silently OFF on iOS** (`[OP-SQLITE] using pure SQLite`), because the podspec's config discovery walks to the pnpm repo root and misses the block at `apps/mobile/package.json:14`. That is why the iOS lane is green: it is not evidence the iOS collision is resolved, it is evidence op-sqlite never links OpenSSL there. **Expect this same collision on iOS the moment 151 is fixed.**


---

## OWNER RULING 2026-07-22 (D22): DROP SQLCipher, RE-HOME AT-REST ENCRYPTION — design first.

The owner chose the correct-by-construction option (not `pickFirst`): remove `sqlcipher: true` from op-sqlite and protect the local SQLite at rest by a mechanism that does not vendor a second OpenSSL. **This is an architecture change to a security control, so it does NOT authorize blind implementation.**

**Next step = a DESIGN pass (owner-reviewed before code):** produce the concrete re-homing mechanism and its threat-model implications —
- what encrypts the SQLite file at rest once SQLCipher is gone (candidates to evaluate: an app-layer key from `expo-secure-store`/Keystore feeding a supported SQLite encryption that reuses quick-crypto's OpenSSL; expo-sqlite's own encryption; or a page-level scheme — establish which are real on Expo SDK 57 + RN 0.86, verified via Context7, not memory);
- where the key lives and how it compares to SQLCipher 4.14's guarantees (what is gained/lost);
- what `10-db-schema` §11 / `security-guide` §7 / `api/02-auth` must change;
- and whether removing SQLCipher also resolves task 151 (iOS SQLCipher-off) or changes its shape.

Bring that mechanism back for the owner before writing code. Only then: implement, with adversarial at-rest tests (wrong key fails; on-disk bytes are not plaintext-SQLite-readable) and the SEC-AUTH-09 leg it feeds. 27a/27b/28/117 stay blocked until the APK builds AND the new at-rest control is proven on the emulator.
