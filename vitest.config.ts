import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Load TS source for workspace packages during tests so Vitest does not use stale dist artifacts.
    conditions: ['source'],
  },
  test: {
    globals: true,
    environment: 'node',
    isolate: true,
    include: ['packages/*/src/**/*.test.ts', 'server/src/**/*.test.ts'],
    // Database-per-file template-clone isolation: the first
    // `createTestDb()` call in each file clones the `eidolon_test_template`
    // database (all migrations pre-applied) into a unique
    // `eidolon_test_<uuid>` database via `CREATE DATABASE ... TEMPLATE`, and
    // subsequent calls TRUNCATE all public-schema tables (RESTART IDENTITY
    // CASCADE) for a fast reset. `afterAll` in `test-setup.ts` drops the
    // per-file database and closes the postgres.js pool. The
    // `globalSetup` drops orphaned `eidolon_test_*` databases before the run.
    // Real Postgres uses TCP (non-blocking), so there is no WASM event-loop
    // contention and forks can scale higher than the previous PGlite cap.
    setupFiles: ['./server/src/test-setup.ts'],
    // With real Postgres there is no WASM blocking, so we can run more
    // forks in parallel. Each fork clones the template database (fast
    // file-level copy, no migrations) and creates a small connection pool.
    // A cap of 6 forks balances speed with Postgres server load from
    // concurrent database clone/drop operations (reduced from 8 to relieve
    // connection contention that caused non-deterministic failures).
    globalSetup: ['./server/src/test-global-setup.ts'],
    poolOptions: {
      forks: {
        maxForks: 6,
      },
    },
    // Template clone takes ~100-300ms on first call per file. Under
    // parallel contention some files can exceed the default 5s, so keep
    // the cap high enough to absorb that without making real regressions
    // silent (60s is still a clear signal if a test hangs).
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.{ts,tsx}', 'server/src/**/*.{ts,tsx}'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'server/src/**/*.test.ts',
        'server/src/test-setup.ts',
        'server/src/test-global-setup.ts',
        'server/src/types.ts',
        '**/*.d.ts',
        '**/types.ts',
      ],
      thresholds: {
        // Thresholds set slightly below the desktop package's levels
        // (lines: 50, statements: 50, functions: 80, branches: 65) to
        // gate against coverage regressions without blocking the existing
        // server and packages test suite.
        lines: 40,
        statements: 40,
        functions: 50,
        branches: 40,
      },
    },
  },
});
