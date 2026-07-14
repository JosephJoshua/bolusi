import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'modules',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
