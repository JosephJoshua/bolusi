// Expo config (08 §6.1: EXPO_PUBLIC_API_URL is the mobile env surface; read here and
// inlined into app code by Expo — EXPO_PUBLIC_* never carries secrets, security-guide §10).
// FCM wiring (android.googleServicesFile) lands with task 21; it is EAS-managed, never committed.
import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Bolusi',
  slug: 'bolusi',
  version: '0.0.0',
  orientation: 'portrait',
  // Forced light appearance is a deliberate product decision, not a default: design-system §0/§1.1
  // ships v0 LIGHT-ONLY (dark mode explicitly deferred) because the fleet is dim, low-cost LCDs used
  // in bright equatorial shops, tuned for a high-contrast light palette. This option ONLY takes
  // effect on Android when `expo-system-ui` is installed (registered in `plugins` below); without it
  // the field typechecks against ExpoConfig yet is DROPPED at prebuild — the pipeline warns
  // "userInterfaceStyle: Install expo-system-ui …" and the app silently follows the OS dark/light
  // setting. The plugin is what makes this line true instead of a well-typed no-op.
  userInterfaceStyle: 'light',
  platforms: ['android', 'ios', 'web'],
  android: {
    package: 'com.bolusi.app',
    // Auto-backup carries nothing off this device (security-guide §6.2:194; api/02-auth §7.4).
    // Android defaults this to TRUE, so omitting it is a decision to back up — not a neutral
    // silence. Every record is server-synced, so there is nothing here worth restoring — and since
    // D22 (task 148) this exclusion carries MORE weight, not less: `bolusi.db` is now a PLAINTEXT
    // SQLite file (only the sensitive columns are sealed, 10-db §9.7), so a restored copy is readable
    // as a database and leaks the op log's structure even though the protected values stay ciphertext.
    // The SecureStore prefs remain Keystore-wrapped to the old handset and never back up, so the
    // column key does not travel — which is exactly why the restored file must not travel either.
    //
    // This is the CLOUD leg only. It is NOT sufficient on its own: Android's own docs say that for
    // apps targeting 12+, "specifying android:allowBackup="false" disables cloud-based backup and
    // restore … but doesn't disable device-to-device transfers for the app". The device-transfer
    // leg is carried by the `dataExtractionRules` that `expo-secure-store` injects below, and both
    // legs are asserted against the GENERATED manifest in test/android-backup.test.ts.
    allowBackup: false,
  },
  ios: {
    // The iOS app identity (api/02-auth §7.4 scopes the Keychain to it; api/04-push ties APNs to
    // it; the App Store identity cannot be changed after release). Owner-chosen, mirrors
    // `android.package`. WITHOUT this block, `@expo/prebuild-config`'s `getPrebuildConfig.js`
    // synthesizes `com.placeholder.appid` via `?? 'com.placeholder.appid'` — silently, no warning
    // (task 83; the exact T-19 "?? on a failed read is a lie generator" shape, in upstream Expo).
    // The GENERATED bundle id is asserted (com.bolusi.app, NOT the placeholder) and falsified in
    // test/ios-config.test.ts.
    bundleIdentifier: 'com.bolusi.app',
  },
  extra: {
    apiUrl: process.env['EXPO_PUBLIC_API_URL'] ?? null,
  },
  plugins: [
    // `configureAndroidBackup` is expo-secure-store's DEFAULT (true), and is spelled out here
    // because this is a security control (security-guide §6.2:194), not a preference: it makes the
    // plugin write `android:dataExtractionRules` + `android:fullBackupContent`, which is what keeps
    // the SecureStore prefs out of BOTH cloud backup and device transfer, and — because Android
    // backs up "only the files specified" once any <include> is present, and those rules include
    // only `sharedpref` — what keeps the client DB (bolusi.db) out of both as well.
    //
    // Relying on the default would leave the control invisible: a grep for `allowBackup` /
    // `data-extraction-rules` over this repo returns nothing, which is precisely how task 58 came to
    // be filed as "nothing implements it" when the generated manifest already carried it. Written
    // out, flipping it to false is a visible diff on a security line rather than a silent default.
    //
    // NOTE the upstream failure mode this pins against: if any other plugin sets those two manifest
    // attributes first, expo-secure-store does NOT fail — it `console.warn`s and silently skips its
    // own rules (withSecureStore.js), leaving a green build with no exclusion. That is the
    // regression test/android-backup.test.ts exists to catch, since nothing else would.
    ['expo-secure-store', { configureAndroidBackup: true }],
    'expo-image',
    'expo-background-task',
    'expo-status-bar',
    // Enables `userInterfaceStyle: 'light'` (top of file) on Android — without this package that
    // option is a typed no-op the prebuild pipeline drops with a warning. Registered explicitly
    // (autolinking would also apply it once installed) so the enabling mechanism is visible beside
    // the option it enables, not an autolinking side-effect nobody chose.
    'expo-system-ui',
    'expo-dev-client',
    // quick-crypto ships its own config plugin (peer: expo-build-properties) — 08 §2.2.
    'react-native-quick-crypto',
    // ── iOS usage descriptions, made DELIBERATE (task 87, D18 §3) ─────────────────────────────
    // The premise task 87 was filed on ("iOS gets NO NSLocationWhenInUseUsageDescription; Apple
    // terminates the app at boot") is REFUTED by the generated artifact. Expo AUTOLINKING already
    // applies these plugins (getPrebuildConfig.js → withLegacyExpoPlugins, gated on the real
    // autolinked module list) even when they are absent from this array — so the compiled Info.plist
    // ALREADY carries NSLocationWhenInUseUsageDescription / NSCameraUsageDescription, with the
    // library ENGLISH DEFAULT strings ("Allow $(PRODUCT_NAME) to access your location"). Task 80 read
    // the STATIC `ios.infoPlist` (null) and the explicit `plugins` list, and missed the autolinked
    // mods — a source-vs-artifact miss (T-16: produce the artifact). The Android leg is the same
    // mechanism (manifest merge), so "the other platform was the guard" understated it: autolinking
    // was covering BOTH platforms, invisibly.
    //
    // Registering explicitly does three real things the autolinked defaults do not:
    //   1. Replaces the English defaults with Indonesian-first, purpose-specific copy — the users are
    //      tech-inadept and Indonesian-first (00-product-overview), and iOS renders this string in a
    //      SYSTEM dialog our i18n runtime and lint rule cannot see (07-i18n; the notifications.ts
    //      channel-name trap). The string is Indonesian because the OS shows the single static value
    //      regardless of device locale (no per-locale InfoPlist.strings in v0).
    //   2. DISABLES the over-declared permissions the autolinked defaults ship: the app requests only
    //      FOREGROUND location (ports/location.ts → requestForegroundPermissionsAsync) and captures
    //      PHOTOS ONLY (media.permission.camera: "ambil foto"). Shipping NSLocationAlways* / NSMotion*
    //      / NSMicrophone* usage strings for permissions the app never requests is an App Store
    //      rejection risk, so each is set `false` (applyPermissions DELETES a key whose value is
    //      `false`; an UNSET key falls through to the English default — verified in
    //      @expo/config-plugins IOSConfig.Permissions.applyPermissions).
    //   3. Makes the config deliberate rather than an autolinking side-effect nobody chose.
    // The GENERATED Info.plist is asserted (the Indonesian strings present, the unused keys ABSENT)
    // and falsified in test/ios-config.test.ts — unregister → the key reverts to the English default
    // → RED, which is why asserting the DELIBERATE string (not mere presence) is load-bearing.
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Izinkan aplikasi memakai lokasi untuk mencatat tempat pekerjaan dilakukan.',
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    // expo-camera is registered now, before task 82 wires capture, so the plist/manifest are correct
    // on both platforms the moment capture lands — and so the denominator guard covers it (task 87
    // acceptance / the cross-reference to 82). Photos only: microphone + Android RECORD_AUDIO are
    // disabled (the app has no audio/video path; 06-media-pipeline is stills). If task 82 adds
    // audio/video, flip microphonePermission to an Indonesian string and recordAudioAndroid to true.
    [
      'expo-camera',
      {
        cameraPermission: 'Izinkan aplikasi memakai kamera untuk ambil foto.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
  ],
};

export default config;
