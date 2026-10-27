import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ui-web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
