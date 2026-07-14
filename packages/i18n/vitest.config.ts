import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'i18n',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
