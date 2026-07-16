# TASK 83 — `app.config.ts` has no `ios` block, so the real prebuild pipeline silently ships `com.placeholder.appid` as the iOS app identity — and every iOS security control is null

**Status:** todo
**Priority:** **HIGH — a LIVE artifact defect, not a gap.** Produced, not inferred (task 80's probe). It is unreachable today only because no iOS build lane exists (task 85) — the moment one does, this is what ships.
**Depends on:** —
**Blocks:** 84 (the iOS §7.4 legs need a real bundle identifier to be scoped to), 85
**SEC ids owned by THIS task:** none — see task 84 for the SEC scope ruling. **Do not mint an id here**: an id with no producer is the class this repo keeps shipping.
**Filed by:** task 80 (iOS parity audit), 2026-07-16, under **D17**.

## The finding — produced from the real pipeline, not grepped

`apps/mobile/app.config.ts` declares `platforms: ['android', 'ios']` and carries an `android` block (`package: 'com.bolusi.app'`, `allowBackup: false`). **There is no `ios` block at all.**

Running the same faithful pipeline `test/android-backup.test.ts` uses — `getPrebuildConfigAsync(MOBILE_ROOT, { platforms: ['ios'] })`, i.e. the exact copy real `expo prebuild` loads — over the shipping config yields:

```
platforms declared      : ["android","ios"]
ios block               : {"bundleIdentifier":"com.placeholder.appid"}
ios.bundleIdentifier    : "com.placeholder.appid"
android.package         : "com.bolusi.app"
ios.entitlements        : null
ios.infoPlist           : null
resolved bundleId       : "com.placeholder.appid"
```

**It does not error. It invents an identity.** The producer, `@expo/prebuild-config@57.0.5` → `build/getPrebuildConfig.js:60-69`:

```js
if (platforms.includes('ios')) {
  if (!config.ios) config.ios = {};
  config.ios.bundleIdentifier = bundleIdentifier ?? config.ios.bundleIdentifier ?? `com.placeholder.appid`;
  …
}
if (platforms.includes('android')) {
  if (!config.android) config.android = {};
  config.android.package = packageName ?? config.android.package ?? `com.placeholder.appid`;
  …
}
```

**One fallback, two platforms, and the only difference is which platform someone thought about.** Android sets `package`, so it never reaches the `??`. iOS has no block, so it takes the placeholder — silently, with no warning on stdout.

**This is T-19's shape (`??` on a failed read is a lie generator) living in upstream Expo.** T-19 was written from task 18's own bugs, where `hashFile`'s dead `?? 0` returned the empty-string SHA-256 — *a real-looking wrong answer*. Same here: a missing bundle identifier does not fail loudly, it becomes a plausible-looking, wrong, and **shared** identifier.

## Why the bundle identifier is not cosmetic

The iOS bundle identifier is the app's **identity**, and three things this project depends on are scoped by it:

1. **The Keychain.** Keychain items are scoped to the app identifier. `keystore.ts`'s `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` — the mechanism delivering `api/02-auth §7.4` on iOS (D17) — stores the Ed25519 seed and device token in a Keychain scoped to `com.placeholder.appid`.
2. **APNs / push.** `api/04-push` registration is tied to the bundle identifier.
3. **App Store identity.** It **cannot be changed after release**, and `com.placeholder.appid` collides with every other Expo project that also forgot.

## And there is no iOS security config at all

`ios.entitlements: null` and `ios.infoPlist: null` — **artifact-level, the same standard task 58 held itself to** (the artifact that ships, not the source that hopes). So the shipping iOS config contributes:

- no `NSFileProtection` class,
- no `isExcludedFromBackupKey` for the SQLCipher DB,
- nothing from `expo-secure-store`'s config plugin (its only iOS knob is `faceIDPermission`, and `requireAuthentication` is deliberately unset — `keystore.ts:42`).

That is the artifact-level evidence for task 84's gap. See it there; do not fix it here.

## Scope

**In:** an `ios` block in `app.config.ts` with a real, owner-chosen `bundleIdentifier`, and a guard that fails when the iOS identity is absent or is a placeholder.

**Out:** the backup-exclusion / file-protection controls (task 84), the build lane (task 85), any UI.

## The owner decision this needs FIRST (CLAUDE.md §6 — outward-facing, hard-to-reverse)

**What is the iOS bundle identifier?** `com.bolusi.app` mirrors `android.package` and is the obvious answer — but it is an App Store identity that cannot be changed after release, so it is an owner's call, not an agent's. **Bring the recommendation (`com.bolusi.app`), do not pick silently.**

## Acceptance

- `app.config.ts` carries `ios: { bundleIdentifier: <owner's choice> }`.
- **THE GUARD IS THE DELIVERABLE** (§2.11 / T-14). Assert the **generated** iOS config, not `app.config.ts` — asserting the source proves only that the file can read itself, and it would have been green throughout the entire period this defect existed. Extend `test/android-backup.test.ts`'s pipeline (`getPrebuildConfigAsync` with `platforms: ['ios']`) or add a sibling; it runs offline in ~1s.
- The guard must fail on **both** shapes: identifier absent, and identifier equal to `com.placeholder.appid`. A guard that only checks presence stays green against the placeholder — which is the actual bug.
- **Falsify it** (§2.11): delete the `ios` block → observe the specific failure; restore → green. **Report the falsification**, never "the test passes".
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green — read the output, not the exit code (§2.1).

## Note

Worth carrying: **the audit that found this expected an error and got an artifact.** The hypothesis was "iOS prebuild fails without a bundle identifier" — reasonable, and wrong. Running it produced a silent placeholder instead, which is strictly worse than the error, and no amount of reading `app.config.ts` would have shown it. That is T-16 clause 5 earning its place: *answer existence by producing the artifact, not by searching for its name.*
