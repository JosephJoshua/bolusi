import { expect, test } from 'vitest';

import config from '../app.config';

test('@bolusi/mobile app config exposes the EXPO_PUBLIC_API_URL surface', () => {
  expect(config.slug).toBe('bolusi');
  // The key must be explicit null when the env var is unset — never undefined
  // (toHaveProperty alone would pass on undefined).
  expect(config.extra?.['apiUrl']).toBe(process.env['EXPO_PUBLIC_API_URL'] ?? null);
  expect(config.extra?.['apiUrl']).not.toBeUndefined();
});

test('@bolusi/mobile is a dev-client app (Expo Go is forbidden, 08 §1)', () => {
  expect(config.plugins).toContain('expo-dev-client');
});
