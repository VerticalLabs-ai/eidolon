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
    // Per-file singleton PGlite: the first `createTestDb()` call in each file
    // creates one in-memory Postgres + runs all Drizzle migrations; subsequent
    // calls TRUNCATE public-schema tables (RESTART IDENTITY CASCADE) for a fast
    // reset, and `afterAll` in `test-setup.ts` closes the client. This drops the
    // suite from ~825 PGlite instances + ~825 full migration runs to one per file.
    setupFiles: ["./server/src/test-setup.ts"],
    // Cap concurrent forks. Each fork runs one file's PGlite WASM instance plus
    // supertest ephemeral HTTP servers; too many concurrent forks starve the
    // event loop and cause intermittent request timeouts. A cap of 4 keeps CPU
    // contention low while staying well within the performance budget (the
    // singleton already removes per-test migration cost). The per-file afterAll
    // in test-setup.ts closes each PGlite so memory stays flat.
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    // With the singleton approach each file creates one PGlite and migrates
    // once (~200-400ms). Under parallel contention some files can still exceed
    // the default 5s, so keep the cap high enough to absorb that without making
    // real regressions silent (30s is still a clear signal if a test hangs).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
