import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db-client',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
