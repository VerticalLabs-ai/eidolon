import { afterAll, afterEach } from 'vitest';
import { closeTestDb } from './test-utils.js';
import { eventBus } from './realtime/events.js';
import { clearRuntimeTotalsCache } from './routes/runtime.js';
import { clearActiveRuntimeSessionControllers } from './services/runtime-sessions.js';

/**
 * Per-file cleanup hook loaded via Vitest `setupFiles`.
 *
 * Each test file runs in its own fork, so the module-level singleton in
 * `test-utils.ts` is scoped to a single file — one PostgreSQL database and
 * connection pool per file. This `afterAll` drops the database and closes the
 * pool once all tests in the file finish, preventing orphaned databases and
 * connection leaks across files. `closeTestDb()` is a no-op when no
 * instance was created.
 */
afterAll(async () => {
  await closeTestDb();
});

/**
 * Clear leaked module-level state after every test.
 *
 * With `maxForks` < number of test files, a single Vitest worker process
 * runs multiple files sequentially and shares module-level singletons
 * between them. Several production modules register `eventBus` listeners or
 * hold module-level caches/maps that are never reset, so they accumulate
 * across files in the same worker and bleed into later tests — a primary
 * source of non-deterministic cross-file failures. Resetting them after
 * each test prevents this bleed. No test relies on this state persisting
 * across `it()` blocks (each test sets up its own state as needed).
 */
afterEach(() => {
  eventBus.removeAllListeners();
  clearRuntimeTotalsCache();
  clearActiveRuntimeSessionControllers();
});
