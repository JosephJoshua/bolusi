import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The identity suites each boot a PGlite instance and run argon2id; parallel files contend on
    // CPU and time out. Serialize files (as db-server does) and allow headroom for the real KDF.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
