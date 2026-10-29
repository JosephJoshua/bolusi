import { describe, expect, test } from 'vitest';

import { qrisFromConfig } from './config.js';

const base = { databaseUrl: 'postgres://x', port: 3000 };
const key = Buffer.alloc(32, 3).toString('base64');

describe('QRIS through Xendit from the boot config', () => {
  test('is off when neither setting is given', () => {
    expect(qrisFromConfig(base)).toBeUndefined();
  });

  test('refuses half a setup, or one with no system key to sign payments with', () => {
    expect(() => qrisFromConfig({ ...base, paymentSecretsKey: key })).toThrow(/both/);
    expect(() =>
      qrisFromConfig({ ...base, paymentSecretsKey: key, publicUrl: 'https://api.test' }),
    ).toThrow(/SYSTEM_KEY_DIR/);
  });

  test('is on with all three', () => {
    const qris = qrisFromConfig({
      ...base,
      paymentSecretsKey: key,
      publicUrl: 'https://api.test',
      systemKeyDir: '/keys',
    });
    expect(qris?.publicUrl).toBe('https://api.test');
  });
});
