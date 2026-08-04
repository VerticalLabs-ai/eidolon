import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as schema from '@eidolon/db';
import type { DbInstance } from './types.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../packages/db/drizzle');

/**
 * Module-level singleton state for the test database.
 *
 * Each Vitest test file runs in its own fork (worker process), so these
 * module-level variables are scoped to a single file — one PGlite instance
 * per file. The first `createTestDb()` call creates the instance and runs all
 * Drizzle migrations; subsequent calls within the same file TRUNCATE all
 * public-schema tables (a fast reset) and return the same `DbInstance`.
 * `closeTestDb()` (wired via `test-setup.ts`'s `afterAll`) closes the client
 * and resets these vars so memory does not accumulate across files.
 */
let _pglite: PGlite | null = null;
let _dbInstance: DbInstance | null = null;

/**
 * TRUNCATE every table in the `public` schema with `RESTART IDENTITY
 * CASCADE`. This clears all user data between tests while preserving the
 * migrated schema. Tables in other schemas (notably
 * `drizzle.__drizzle_migrations` in the `drizzle` schema) are excluded
 * automatically because the query only targets the `public` schema.
 * Future-proof: new tables added in later migrations are included without
 * code changes.
 */
async function resetTestDb(): Promise<void> {
  if (!_pglite) return;

  const result = await _pglite.query<{
    tablename: string;
  }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const tables = result.rows.map((row) => row.tablename);
  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"public"."${t}"`).join(', ');
  await _pglite.query(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Create an in-memory Postgres-compatible database (via PGlite) for testing.
 *
 * Uses a module-level singleton: the first call per test file creates a
 * PGlite instance, runs all Drizzle migrations, and stores the result.
 * Subsequent calls TRUNCATE all public-schema tables (a fast reset, ~5-20ms)
 * and return the same `DbInstance`. This keeps the `createTestDb()` API
 * identical for callers (still safe in `beforeEach`) while avoiding ~825
 * full migration runs per suite. Cleanup happens via `closeTestDb()` in
 * `test-setup.ts`'s `afterAll`.
 */
export async function createTestDb(): Promise<DbInstance> {
  if (_dbInstance && _pglite) {
    await resetTestDb();
    return _dbInstance;
  }

  const client = await PGlite.create();
  const drizzleDb = drizzle(client);
  await migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

  _pglite = client;
  _dbInstance = {
    drizzle: drizzleDb,
    schema,
  };

  return _dbInstance;
}

/**
 * Close the singleton PGlite client and reset module-level state.
 *
 * Registered as an `afterAll` hook via `server/src/test-setup.ts` so each
 * test file releases its PGlite instance before the worker process exits,
 * preventing memory accumulation across files.
 */
export async function closeTestDb(): Promise<void> {
  if (_pglite) {
    await _pglite.close();
  }
  _pglite = null;
  _dbInstance = null;
}

/**
 * Create an Express app wired to the given test database instance.
 */
export function createTestApp(db: DbInstance, authMode = 'local_trusted') {
  const previousAuthMode = process.env.AUTH_MODE;

  try {
    process.env.AUTH_MODE = authMode;
    return createApp(db);
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = previousAuthMode;
    }
  }
}
