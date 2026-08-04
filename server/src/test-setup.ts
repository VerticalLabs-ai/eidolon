import { afterAll } from 'vitest';
import { closeTestDb } from './test-utils.js';

/**
 * Per-file cleanup hook loaded via Vitest `setupFiles`.
 *
 * Each test file runs in its own fork, so the module-level singleton PGlite
 * in `test-utils.ts` is scoped to a single file. This `afterAll` closes that
 * instance once all tests in the file finish, preventing memory accumulation
 * across files. `closeTestDb()` is a no-op when no instance was created.
 */
afterAll(async () => {
  await closeTestDb();
});
