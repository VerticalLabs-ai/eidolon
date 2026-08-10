import { afterAll, afterEach } from 'vitest';
import { closeTestDb, closeTestServers } from './test-utils.js';
import { eventBus } from './realtime/events.js';
import { backgroundWork } from './services/background-work.js';

/**
 * Hermetic test environment — neutralize auth-relevant env vars that may
 * leak from the developer's gitignored `.env` (or shell, or `.env.local`)
 * into `process.env` before any test request runs.
 *
 * Why this is needed: the CSRF middleware (`middleware/csrf.ts`) reads
 * `process.env.AUTH_MODE` at REQUEST time and skips CSRF enforcement when
 * it is `'local_trusted'`, while the auth middleware captures `AUTH_MODE`
 * at app-creation time. `createTestApp()` sets `AUTH_MODE` only for the
 * duration of `createApp()` and restores the previous value afterward, so
 * a leaked `AUTH_MODE=local_trusted` resurfaces at request time and causes
 * `csrf.test.ts` to get 401 (auth gate) instead of the intended 403 (CSRF
 * gate). `CLERK_SECRET_KEY` and `VITE_AUTH_MODE` are the other auth-relevant
 * vars named in `test-utils.ts`'s env-loading comment; leaving them set can
 * make authenticated-mode tests attempt real Clerk network calls or change
 * frontend auth behavior. Tests must control auth exclusively via
 * `createTestApp()`/`createTestServer()`'s `authMode` parameter.
 *
 * This runs at setup-file module top level, before any test file's tests
 * (Vitest evaluates setupFiles before the test file's imports execute), so
 * it neutralizes the leak before any request can observe it. It is NOT
 * masking: the csrf tests then run under their intended enforced-CSRF
 * condition and pass legitimately. `DATABASE_URL` is intentionally kept —
 * tests need it to reach Postgres.
 */
delete process.env.AUTH_MODE;
delete process.env.CLERK_SECRET_KEY;
delete process.env.VITE_AUTH_MODE;
// Neutralize leaked LLM provider keys so meeting-service.ts `resolveLlm()`
// returns null in every test. Without this, a developer's gitignored
// `.env` ANTHROPIC_API_KEY/OPENAI_API_KEY/GOOGLE_API_KEY leaks into
// `process.env` and `summarizeMeeting()`/`extractActionItems()` make real
// network calls, blowing past the meetings test's 3000ms `collectUntil`
// timeout. With the keys deleted, both fall back to the deterministic
// extractive path (no network, immediate emit).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

// VAL-SEC-009: the auth-sensitive rate limiter is always-on outside tests so
// the 429 posture is demonstrable in dev/validation. The deterministic
// real-Postgres suite must never self-throttle, so bypass it for every test.
process.env.EIDOLON_RATE_LIMIT_TEST_BYPASS = '1';

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
afterEach(async () => {
  // Drain all in-flight background work BEFORE removing listeners and
  // closing servers. This ensures fire-and-forget follow-up writes (mention
  // dispatch, activity logging, co-edit flush) complete before the next
  // test's resetTestDb() TRUNCATEs all tables — preventing the Postgres
  // deadlock (40P01/55P03) that occurred when TRUNCATE's ACCESS EXCLUSIVE
  // lock collided with in-flight background writes.
  await backgroundWork.drain();
  eventBus.removeAllListeners();
  // Close all persistent listening servers created via createTestServer so
  // no server leaks across tests. This eliminates the per-request
  // listen(0)/close() churn that caused supertest response desync.
  await closeTestServers();
});
