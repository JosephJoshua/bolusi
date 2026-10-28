// Zod-validated boot config (security-guide §10): read once, fail loud on a missing required var.
import { describe, expect, test } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  test('parses DATABASE_URL and defaults PORT to 3000', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(config).toEqual({
      databaseUrl: 'postgres://u:p@localhost:5432/db',
      port: 3000,
      secureCookies: true,
    });
  });

  test('coerces a PORT string to an integer', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x', PORT: '8080' });
    expect(config.port).toBe(8080);
  });

  test('marks cookies Secure unless PUBLIC_URL is a plain-http origin', () => {
    const at = (PUBLIC_URL?: string) =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        ...(PUBLIC_URL === undefined ? {} : { PUBLIC_URL }),
      }).secureCookies;
    expect(at()).toBe(true);
    expect(at('https://api.example.com')).toBe(true);
    expect(at('http://192.168.1.5:3000')).toBe(false);
    expect(() => at('not a url')).toThrow(/Invalid server configuration/);
  });

  test('throws when DATABASE_URL is absent', () => {
    expect(() => loadConfig({})).toThrow(/Invalid server configuration/);
  });

  test('throws on an out-of-range PORT', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: '70000' })).toThrow();
  });
});
