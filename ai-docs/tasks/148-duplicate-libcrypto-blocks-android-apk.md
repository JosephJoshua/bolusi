# TASK 148 — the Android APK CANNOT BE ASSEMBLED: op-sqlite (SQLCipher) and react-native-quick-crypto each ship their own `libcrypto.so`, and `:app:mergeReleaseNativeLibs` refuses

**Status:** in-progress
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


---

## DESIGN PASS 2026-07-22 (investigation only — nothing implemented). Finding: "drop SQLCipher" NECESSARILY means "lose whole-file encryption." Owner must accept the reshaped guarantee before code.

Verified against the actual op-sqlite/expo-sqlite type defs + CMake + Expo SDK-57 docs (Context7), not memory.

### There is no whole-file replacement without a second OpenSSL
- **op-sqlite BYO-cipher reusing quick-crypto's OpenSSL — DOES NOT EXIST.** op-sqlite's only encryption path is compiled-in SQLCipher; `Storage.d.ts:7`: the key "is only used when compiled against the SQLCipher version." No `sqlite3_key`-with-your-own-crypto hook is exposed.
- **expo-sqlite `useSQLCipher` — REPRODUCES 148 and is worse.** Its Android CMake does `find_package(openssl … CONFIG)` → the SAME `libcrypto.so` collision; also breaks Android 16 KB pages (expo/expo#39792); also a D6 reversal to the slower engine. The collision is OpenSSL↔quick-crypto, not op-sqlite-specific — switching engines does not escape it.
- **Version-align + pickFirst — still the forbidden directive** (AGP `acceptOnlyOne()` throws on the duplicate path regardless of content). Upstream #1059 Option B (static-link, hidden visibility) is unshipped.
- **Whole-file "vault" (encrypt file, decrypt a working copy) — rejected:** writes a plaintext DB working file the whole time the app runs / is backgrounded (worse for the lost/stolen-locked-device threat), plus a full-file decrypt on every cold start scaling with DB size on a 2 GB device.

### RECOMMENDED mechanism: application-layer AEAD on the sensitive columns, via quick-crypto's already-linked OpenSSL 3.6.2
quick-crypto (1.1.6, already the sole on-device crypto per D8) exposes AES-256-GCM / ChaCha20-Poly1305 / hkdf / pbkdf2 (`cipher.d.ts`). Encrypting value-bearing columns adds ZERO native deps and ZERO second `libcrypto` — the only mechanism that satisfies the D22 constraint and is real on the stack today.
- **Key: unchanged** — 32 CSPRNG bytes in `expo-secure-store` (Keystore-wrapped, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), the existing `SecureStoreDbKeyStore` producer carries over; feeds an app-layer AEAD instead of `open({encryptionKey})`. Not PIN-derived (per-device, per §6.4).
- **Encrypt (safe — read whole, never SQL-filtered by content):** op-log `payload`, `signed_core_jcs`, `location`; note `title`/`body`; `user_pin_verifiers` salt/hash/params (the SEC-AUTH-09 material); media capture-context; quarantined `signed_core_jcs`. Columns stay `TEXT` (base64 ciphertext) → **codegen types essentially unaffected** (value transform, not schema change).
- **LOST vs SQLCipher:** all relational structure stays plaintext and MUST (ids, `entity_type`/`type`, `seq`/`timestamp_ms`, `hash`/`previous_hash`/`signature`, `sync_status`, FKs, row counts, indexes). A forensic reader of the raw file on a non-running device learns the **activity shape** (how many ops of what type against which entities/users/devices, when) but not the sensitive **values** (note bodies, GPS, PIN verifiers). Migration gotcha: encrypting an existing plaintext column leaves old plaintext in freed pages until `VACUUM`.

### Threat-model delta the owner must accept
- Attacker with the file but not SecureStore/Keystore: SQLCipher → reads nothing; app-layer → reads metadata/shape, NOT the encrypted PII/verifiers.
- Attacker running AS the app: reads the key and decrypts everything — **identical to SQLCipher today** (already accepted; revocation is the answer, not storage).
- In-scope threat is insider / lost-or-stolen device (root malware + hardware/Keystore attacks are OUT, §1). The crown jewels (Ed25519 seed, device token) already live in SecureStore, NOT the DB. So the concrete new residual = **metadata/activity-shape exposure to forensic extraction of a non-running, non-rooted device.**

### Interactions
- **Task 151 largely DISSOLVES (re-scope, don't close):** encryption becomes platform-agnostic JS, so "iOS SQLCipher-off" is no longer a bug and the "iOS collision the moment you fix the config" risk is pre-empted (op-sqlite links no OpenSSL on either platform). BUT 151's root cause (the podspec misses the config block at the pnpm repo root) still governs **`performanceMode`** — re-scope 151 to "prove performanceMode is discovered on iOS."
- **D6 preserved** (op-sqlite engine unchanged). **D8 untouched** (DB key random-in-SecureStore, never PIN-derived). **16 KB-page risk REDUCED** (one fewer native OpenSSL lib).
- **Testability WIN:** the driver-conformance suite already runs on better-sqlite3 (no SQLCipher), so CI never exercised SQLCipher; app-layer AEAD is deterministically testable in Node/CI.

### Perf
op-sqlite in-op throughput (D6 / P-2 floor) preserved (pages written plaintext at the SQLite layer). NEW cost: app-layer AEAD per sensitive value on hot paths (pull-apply, rebuild folds thousands of ops) — native AES-GCM is fast but is a JSI round-trip per value. Small payloads, minimal set → likely modest, but it is a NEW cost on a P-2 budget that is **only assumed to pass (D21), never measured** → quantifiable only on the emulator/2 GB device.

### Honest ceiling (emulator/device-only)
1. That `op-sqlite(sqlcipher:false) + quick-crypto` **actually assembles** with no duplicate `libcrypto` (#1059's reporter says clean; **not built here** — no Android SDK).
2. That app-layer AEAD holds the P-2 write floor on 2 GB.
3. That the produced build's raw file is genuinely ciphertext-for-the-protected-columns + wrong-key-fails (JS is CI-testable; the artifact wants the emulator + SEC-DEV-06).

### DECISION REQUIRED FROM THE OWNER before any code
1. **Accept the reshaped guarantee** — "sensitive values are AEAD-ciphertext; relational metadata/structure/activity-shape are plaintext", replacing "whole DB opaque". SEC-DEV-06 / SEC-AUTH-09 / §1 threat-model reworded to match.
2. **Approve the encrypted-column set** (the list above — the security-critical call; a missed column is a silent PII leak).
3. **Accept the residual** (metadata/shape to forensic extraction; app-as-attacker unchanged) and the **perf unknown** (emulator-verified).
4. **Re-scope task 151** to the performanceMode-discovery half.

If whole-file coverage is a HARD requirement, the honest finding is **there is no good option on this stack** — every whole-file route is forbidden (`pickFirst`), unshipped (#1059 Option B), or fragile (vault). Then the only path is waiting on upstream and Android stays blocked.
