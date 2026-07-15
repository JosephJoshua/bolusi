// Zod-validated boot config (security-guide §10): read once, fail loud on a missing required var.
import { describe, expect, test } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  test('parses DATABASE_URL and defaults PORT to 3000', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(config).toEqual({ databaseUrl: 'postgres://u:p@localhost:5432/db', port: 3000 });
  });

  test('coerces a PORT string to an integer', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x', PORT: '8080' });
    expect(config.port).toBe(8080);
  });

  test('throws when DATABASE_URL is absent', () => {
    expect(() => loadConfig({})).toThrow(/Invalid server configuration/);
  });

  test('throws on an out-of-range PORT', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: '70000' })).toThrow();
  });
});
