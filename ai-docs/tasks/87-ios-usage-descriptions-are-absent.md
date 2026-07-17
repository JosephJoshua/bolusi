# TASK 87 — `expo-location`'s config plugin is unregistered: Android gets its permissions free via manifest merging, iOS gets no `NSLocationWhenInUseUsageDescription` — and `Root.tsx:89` requests location at every boot

**Status:** in-progress
**Priority:** **HIGH** — the highest-consequence iOS finding in the audit. The Android leg is covered **by accident**, by a platform mechanism iOS does not have, which is why nothing has ever noticed. Apple documents termination for this; see §What is verified for exactly how far that claim goes.
**Depends on:** 83 (`app.config.ts`'s `ios` block), 85 (nothing here is runtime-verifiable until iOS can be built)
**Blocks:** any iOS boot; task 82's capture path has the identical shape
**SEC ids owned by THIS task:** none.
**Filed by:** task 80 (iOS parity audit), 2026-07-16, under **D17**.

## The finding — both artifacts produced, side by side

`expo-location@57.0.2` is a **dependency** in `apps/mobile/package.json` and is **not** in `app.config.ts`'s `plugins` array. It ships `app.plugin.js` → `plugin/build/withLocation.js`, which carries `const LOCATION_USAGE = 'Allow $(PRODUCT_NAME) to access your location'` and injects the iOS usage descriptions. **It never runs.**

Task 80 compiled the real prebuild mods for **both** platforms over the shipping config:

```
ANDROID uses-permission in the GENERATED manifest:
    android.permission.ACCESS_COARSE_LOCATION      ← present
    android.permission.ACCESS_FINE_LOCATION        ← present
    android.permission.CAMERA
    android.permission.INTERNET
    android.permission.READ_EXTERNAL_STORAGE
    android.permission.RECORD_AUDIO
    android.permission.WRITE_EXTERNAL_STORAGE

IOS ios.infoPlist                              : null
IOS NSLocationWhenInUseUsageDescription present: false
IOS plugins actually registered : ["expo-secure-store","expo-image","expo-background-task",
                                  "expo-status-bar","expo-dev-client","react-native-quick-crypto"]
```

**Android is fine and nobody arranged it.** Android merges each library's own `AndroidManifest.xml` into the app's, so autolinking `expo-location` contributes `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` **whether or not the config plugin is registered**. `CAMERA` and `RECORD_AUDIO` arrive the same way, from `expo-camera`, which is also not in `plugins`.

**iOS has no equivalent.** There is no Info.plist merging from pods; usage descriptions come from the config plugin (CNG) or a hand-edited `ios/[app]/Info.plist`. This project uses CNG and registers no such plugin, so the key is **absent from the artifact**.

**And the code requests the permission at boot.** `bootstrap/Root.tsx:89` calls `startLocationWatcher()` in its mount effect, which is `ports/location.ts:42`:

```ts
const { granted } = await Location.requestForegroundPermissionsAsync();
```

## Why this one is the audit's thesis in a single file

Every other finding is *something absent on iOS*. This is the sharper shape: **the same config and the same code produce a working Android app and a broken iOS one, because a platform mechanism silently supplied on one side what the config forgot on both.** The missing plugin registration is not a latent Android bug that iOS also has — on Android it is **not a bug at all**. So there is no Android symptom, no failing test, no warning, and no reviewer prompt. It is invisible by construction, which is exactly what CLAUDE.md §2.11 means by a claim nothing checks — here operating on the *config plugin list*.

`app.config.ts`'s `plugins` array reads like a complete list of the app's native configuration. It is a list of the plugins **someone remembered**, and Android's generosity has been covering the difference.

## What is verified, and what is not (read this before repeating any of it)

- **VERIFIED — artifact level**, by compiling the real pipeline (`getPrebuildConfigAsync` + `compileModsAsync`, the copy real `expo prebuild` loads): Android's generated manifest carries both location permissions; iOS's `infoPlist` is `null` and carries no `NSLocationWhenInUseUsageDescription`; the plugin list contains no `expo-location`.
- **VERIFIED — source level**: `expo-location` ships a config plugin that would inject the key; `Root.tsx:89` → `location.ts:42` requests foreground permission at every boot.
- **DOCUMENTED — Expo's own SDK docs** (fetched live, not recalled): the usage-description keys are set by the `expo-location` config plugin under CNG, and *"If CNG is not used, manual configuration is necessary"* — i.e. the key is required for iOS either way.
- **NOT VERIFIED — the runtime consequence.** Apple's documented behaviour is that iOS **terminates** an app that accesses a protected resource with no usage description, which would make this a **boot-time crash on every iOS device**. **Task 80 could not run it**: there is no physical iPhone, no macOS host, no Xcode, and all 10 CI jobs are `ubuntu-latest` (see task 80 §4 and task 85). **Do not state the crash as observed.** State it as documented-and-unverified until a target exists.

## Scope

**In:** registering the iOS-relevant config plugins with real, Indonesian-first, owner-approved permission copy, and a guard that fails when a native module in `dependencies` needs an iOS usage description the generated `infoPlist` does not carry.

**Out:** the `ios` block itself (**83**), the build lane (**85**), the media capture path (**82** — same shape, cross-referenced below, do not fix it here).

## Docs to read

- `ai-docs/tasks/80-*.md` §Outcome — the parity table, the probe, and the device-gap wording to reuse.
- **`expo-location` and `expo-camera` SDK docs via Context7 — read the platform column yourself, do not trust this file's quotes** (§2.1). If the plugin's contract has moved, **the premise moved — stop and report**.
- `07-i18n.md` — the permission strings are **user-visible copy**, in a system dialog our lint rule cannot see (the same trap `notifications.ts:45` already documents for Android channel names).
- `testing-guide.md` **T-14** (a guard asserts its own denominator), **T-15**, **T-16**, **T-14f**.
- `CLAUDE.md` §2.11, §6.

## Acceptance

- The generated iOS `infoPlist` carries a usage description for every protected resource this app touches.
- **THE GUARD IS THE DELIVERABLE, and it must have a denominator** (T-14). A guard that checks "`NSLocationWhenInUseUsageDescription` is present" closes today's instance and stays green when task 82 adds `expo-camera` capture without `NSCameraUsageDescription` — **that is this bug again, on a delay.** Enumerate the app's native dependencies and assert that each one's required iOS usage descriptions are present in the **generated** artifact; fail loudly on a starved enumeration (zero modules checked must be RED, never green).
- **Falsify it** (§2.11): unregister the plugin → observe the specific failure; restore → green. **Report the falsification**, never "the test passes".
- **The permission copy is owner-facing** (`07-i18n`): the user is tech-inadept and Indonesian-first, and this string appears in an iOS system dialog. `'Allow $(PRODUCT_NAME) to access your location'` is the library's English default. **Do not ship the default silently** — and note the honest constraint that iOS renders this string in the OS's own locale handling, so §7's rules apply awkwardly here. Bring it to the owner with the copy, do not pick silently.
- **Cross-reference task 82** (media capture, in flight on `integrate/18`): `expo-camera` is in `dependencies`, is **not** in `plugins`, and its Android permissions (`CAMERA`, `RECORD_AUDIO`) are already arriving via the same manifest merging. When 82 builds capture, iOS will need `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`. **The denominator guard above is what makes that impossible to forget** — build it here so 82 inherits it.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green. Read the output, not the exit code (§2.1).

## Note

Task 58's lesson was *the comment was the guard*. This one's is narrower and nastier: **the other platform was the guard.**

Nobody wrote a comment claiming location permissions were configured. Nobody had to — the app worked. Android's manifest merging quietly delivered what `app.config.ts` never asked for, and a working app is the most persuasive evidence there is that the config is complete. The `plugins` array has been an incomplete list all along, and the only reader who could have noticed is a platform that has never been built.

Worth carrying: **when two platforms share one config, the more forgiving one hides the other's requirements.** "It works on Android" is not evidence about the config; it is evidence about Android. That is `T-14f` (*"typed and compiling" is not "running on the target"*) with the target made plural — and the corollary is that the *first* iOS build this project ever runs will surface a backlog of these at once, not one.
