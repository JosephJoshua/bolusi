# TASK 148 — the Android APK CANNOT BE ASSEMBLED: op-sqlite (SQLCipher) and react-native-quick-crypto each ship their own `libcrypto.so`, and `:app:mergeReleaseNativeLibs` refuses

**Status:** todo
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
