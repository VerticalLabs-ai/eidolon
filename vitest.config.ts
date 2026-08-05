import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Load TS source for workspace packages during tests so Vitest does not use stale dist artifacts.
    conditions: ["source"],
  },
  test: {
    globals: true,
    environment: "node",
    isolate: true,
    include: ["packages/*/src/**/*.test.ts", "server/src/**/*.test.ts"],
    // Per-file schema isolation on the eidolon_test database: the first
    // `createTestDb()` call in each file creates a unique PostgreSQL schema,
    // runs all Drizzle migrations inside it, and sets search_path so all
    // queries target that schema. Subsequent calls TRUNCATE the schema's
    // tables (RESTART IDENTITY CASCADE) for a fast reset, and `afterAll` in
    // `test-setup.ts` drops the schema and closes the postgres.js pool.
    // Real Postgres uses TCP (non-blocking), so there is no WASM event-loop
    // contention and forks can scale higher than the previous PGlite cap.
    setupFiles: ["./server/src/test-setup.ts"],
    // With real Postgres there is no WASM blocking, so we can run more
    // forks in parallel. Each fork clones the template database (fast
    // file-level copy, no migrations) and creates a small connection pool.
    // A cap of 6 forks balances speed with Postgres server load from
    // concurrent database clone/drop operations (reduced from 8 to relieve
    // connection contention that caused non-deterministic failures).
    globalSetup: ["./server/src/test-global-setup.ts"],
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
  },
});
