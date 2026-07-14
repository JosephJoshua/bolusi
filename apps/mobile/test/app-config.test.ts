import { expect, test } from 'vitest';

import config from '../app.config';

test('@bolusi/mobile app config exposes the EXPO_PUBLIC_API_URL surface', () => {
  expect(config.slug).toBe('bolusi');
  // The key must exist even when the env var is unset (explicit null, never undefined).
  expect(config.extra).toHaveProperty('apiUrl');
});

test('@bolusi/mobile is a dev-client app (Expo Go is forbidden, 08 §1)', () => {
  expect(config.plugins).toContain('expo-dev-client');
});
