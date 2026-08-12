import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{cjs,js}'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 80,
        branches: 65,
      },
    },
  },
});
