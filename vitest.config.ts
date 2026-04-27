import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Load TS source for workspace packages during tests so Vitest does not use stale dist artifacts.
    conditions: ["source"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "server/src/**/*.test.ts"],
    // PGlite spins up an in-memory Postgres per test and runs full Drizzle
    // migrations on each `createTestDb()`. Under parallel contention some
    // test files exceed the default 5s. Keep the cap high enough to absorb
    // that without making real regressions silent (30s is still a clear
    // signal if a test is truly hanging).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
