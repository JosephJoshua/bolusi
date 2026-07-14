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
  },
  extra: {
    apiUrl: process.env['EXPO_PUBLIC_API_URL'] ?? null,
  },
  plugins: [
    'expo-secure-store',
    'expo-image',
    'expo-background-task',
    'expo-status-bar',
    'expo-dev-client',
    // quick-crypto ships its own config plugin (peer: expo-build-properties) — 08 §2.2.
    'react-native-quick-crypto',
  ],
};

export default config;
