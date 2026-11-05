import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The tests share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
