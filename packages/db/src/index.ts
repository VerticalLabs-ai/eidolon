import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema/index.js';

export * from './schema/index.js';
export { schema };

export interface DbInstance {
  db: PostgresJsDatabase<typeof schema>;
  client: Sql;
}

/**
 * Resolve a Postgres connection string from the ambient env. Honors, in
 * order:
 *   1. The explicit `url` argument.
 *   2. POSTGRES_URL (Supabase / Vercel Marketplace provisions this).
 *   3. DATABASE_URL (local-first convention, what pnpm run dev uses).
 *
 * Throws if none are set.
 */
export function resolveConnectionString(url?: string): string {
  const connectionString =
    url ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'No Postgres connection string set. Locally: `pnpm run db:start` + ' +
        'DATABASE_URL. On Vercel: the Supabase Marketplace integration ' +
        'provisions POSTGRES_URL automatically.',
    );
  }
  return connectionString;
}

/**
 * Create a database instance backed by Postgres via postgres.js.
 *
 * @param url - Postgres connection string. Defaults to env resolution above.
 * @param options.max - Pool size. On serverless set to 1; locally 10 is fine.
 */
export function createDb(
  url?: string,
  options: { max?: number } = {},
): DbInstance {
  const connectionString = resolveConnectionString(url);
  const client = postgres(connectionString, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });

  return { db, client };
}
