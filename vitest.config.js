import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['test/**/*.test.js'],
    testTimeout: 15000,
    hookTimeout: 10000,
  },
});
