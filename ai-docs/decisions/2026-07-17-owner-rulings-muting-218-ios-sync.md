# D18 — Four owner rulings (2026-07-17): push muting, §218, iOS parity, sync-loop priority

**Date:** 2026-07-17 · **Status:** Accepted — owner decisions, in response to the batched questions.

## 1. Push muting (task 59) → **DEEP-LINK to the OS per-channel settings**

The in-app mute toggle becomes a **row that opens the platform's own notification settings**, not a control that sets channel importance (which Android forbids post-creation, and iOS has no channels for).

- **Android:** deep-link to the app's per-channel settings (`Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS` / the per-app notification screen). The boot-created channels are what make per-category control exist there.
- **iOS (D17 — first-class):** deep-link to `UIApplication.openNotificationSettingsURLString` (iOS 16+) or the app's Settings page. iOS has no per-category channels, so the row opens the app-level notification settings; **v0 does not claim per-category iOS muting** — state that limit in `api/04-push §5`.
- **`api/04-push §5` is rewritten** (doc-first, its own task): the muting model is "the toggle opens OS settings," not "the toggle is channel importance." Delete `applyChannelImportance` (zero callers, a resolving no-op). The `sync`-gets-no-channel reasoning stays.
- **Rejected:** delete/recreate channel (Android restores old settings to defeat exactly this); server-side suppression (v1, forfeits killed-app OS suppression).
- Task 59 moves from *blocked-on-decision* to *buildable*; **depends on task 21** (push wiring) for the settings-screen host.

## 2. SEC-DEV-04 §218 (task 70) → **§218 IS OVER-SPECIFIED**

`security-guide §218`'s *"queued ops → `DEVICE_REVOKED`, kept + surfaced as `rejected`"* is **dropped**. The real, buildable guarantee — already 3/5 shipped and matching `api/02-auth §7.3` — is: **a revoked device cannot sync, and its unsynced work is wiped (crypto-erase), not leaked or resurrected.**

- **Why:** the wire 401s at the auth middleware before any per-op rejection code runs (normative, `api/02-auth §8`/§9), the client has no 401→op-marking path, and "kept" contradicts §7.3's by-design wipe. Building it literally would let **one spurious 401 permanently delete a shop's unsynced work** (`rejected` is terminal). §7.3 is the stronger, more recent control; it wins.
- **The work (task 70):** doc-first edit `security-guide §218` to the wiped-not-leaked wording; then **SEC-DEV-04 can be honestly retired** — the 3 shipped behaviours (continues-offline, kept-locally-until-wipe, none-accepted) now fully discharge the corrected requirement, so it comes off task 62/70's allowlist. This also unblocks **task 28**'s empty-allowlist roll-up.

## 3. iOS (D17, tasks 80/83–87) → **FULL PARITY PUSH NOW; iOS is co-equal for all new work**

iOS is not a defer-to-v1 target. Every new task states and satisfies **both** platform legs, or states which is unverifiable and why.

- **Build now (headless-achievable):** the real iOS `app.config.ts` block + `bundleIdentifier` (kills the `com.placeholder.appid` silent default — task 83); iOS backup-exclusion leg — `NSFileProtection` + `isExcludedFromBackupKey` for the SQLCipher DB + the Keychain accessibility already set (task 84); iOS usage descriptions (`NSLocationWhenInUseUsageDescription`, `NSCameraUsageDescription`) + register `expo-location`/`expo-camera` plugins so the manifest/plist is correct on **both** platforms (task 87 — Android's manifest-merging was silently covering this); `SEC-DEV-08`/§6 gets an iOS row or an explicit "iOS uncovered" statement.
- **The hard limit, stated not hidden:** there is **no iOS runnable target** on this infrastructure — Linux host, no Xcode, CI is `ubuntu-latest`, the Simulator needs macOS. So iOS legs are verified **at the config/prebuild-artifact level** (like task 58's Android guard), and every iOS residual risk says *"unverified on-device; no iOS hardware or Simulator exists here"* (D12/D13, doubled). Task 85 (the iOS build/verification LANE) records this as a real infrastructure gap the owner must close (a macOS runner / EAS) for on-device verification — it is not a coding task.
- **The frontend bar (D17) stands:** UI work loads `frontend-design` + `impeccable`; beautiful on **both** platforms, not an Android layout in an iOS shell.

## 4. Priority → **WIRE THE SYNC LOOP (tasks 88 + 89)**

The app boots its data layer but does not sync. That is the biggest functional gap and the next build.

- **88:** enrollment persists `deviceId`/`storeId` to `meta_kv` (`10-db §9` names them; today enrollment returns the id and drops it).
- **89:** the `BundleRefreshPort` producer (task 14 shipped `applyBundle`, not the fetch half), the `SyncLoop` construction, an enrollment caller (`runEnrollment` has zero prod callers), NetInfo (pin it — `08 §2.2`, was a §6 stop-and-ask). After this, `lastSuccessfulSyncAt` becomes real and the never-connected banner clears on first sync.
- Then v0's exit path (notes 25, emulator lane 27a) has a syncing app to run against.
