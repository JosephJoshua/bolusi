// Expo config (08 §6.1: EXPO_PUBLIC_API_URL is the mobile env surface; read here and
// inlined into app code by Expo — EXPO_PUBLIC_* never carries secrets, security-guide §10).
// FCM wiring (android.googleServicesFile) lands with task 21; it is EAS-managed, never committed.
import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Bolusi',
  slug: 'bolusi',
  version: '0.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  platforms: ['android', 'ios'],
  android: {
    package: 'com.bolusi.app',
    // Auto-backup carries nothing off this device (security-guide §6.2:194; api/02-auth §7.4).
    // Android defaults this to TRUE, so omitting it is a decision to back up — not a neutral
    // silence. There is nothing here worth restoring: every record is server-synced, and both the
    // SQLCipher DB and the SecureStore prefs are ciphertext whose wrapping key is hardware-bound to
    // the old handset and never backed up, so a restore yields undecryptable bytes rather than data.
    //
    // This is the CLOUD leg only. It is NOT sufficient on its own: Android's own docs say that for
    // apps targeting 12+, "specifying android:allowBackup="false" disables cloud-based backup and
    // restore … but doesn't disable device-to-device transfers for the app". The device-transfer
    // leg is carried by the `dataExtractionRules` that `expo-secure-store` injects below, and both
    // legs are asserted against the GENERATED manifest in test/android-backup.test.ts.
    allowBackup: false,
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
    // only `sharedpref` — what keeps the SQLCipher DB (bolusi.db) out of both as well.
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
    'expo-dev-client',
    // quick-crypto ships its own config plugin (peer: expo-build-properties) — 08 §2.2.
    'react-native-quick-crypto',
  ],
};

export default config;
