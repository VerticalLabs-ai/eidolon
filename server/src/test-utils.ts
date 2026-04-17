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
 * Create an in-memory Postgres-compatible database (via PGlite) for testing.
 * Each call returns a completely isolated database so tests do not interfere
 * with one another. The same Drizzle migrations that run in production are
 * applied here so the test schema never drifts from prod.
 */
export async function createTestDb(): Promise<DbInstance> {
  const client = new PGlite();
  const drizzleDb = drizzle(client);
  await migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    drizzle: drizzleDb,
    schema,
  };
}

/**
 * Create an Express app wired to the given test database instance.
 */
export function createTestApp(db: DbInstance, authMode = 'local_trusted') {
  const previousAuthMode = process.env.AUTH_MODE;
  // CSRF middleware re-reads env per-request; set a dedicated disable flag
  // that outlives createApp's finally block so test supertest calls (which
  // never include an Origin header) aren't rejected as CSRF violations.
  // The CSRF test file overrides this explicitly when it needs enforcement.
  if (authMode === 'local_trusted') {
    process.env.EIDOLON_DISABLE_CSRF = '1';
  } else {
    delete process.env.EIDOLON_DISABLE_CSRF;
  }

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
