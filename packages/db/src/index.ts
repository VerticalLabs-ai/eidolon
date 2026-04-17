import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema/index.js';

export * from './schema/index.js';

export interface DbInstance {
  db: PostgresJsDatabase<typeof schema>;
  client: Sql;
}

/**
 * Create a database instance backed by Postgres via postgres.js.
 *
 * @param url - Postgres connection string. Defaults to `process.env.DATABASE_URL`.
 *   Must be provided one way or the other — there is no file fallback.
 * @returns The Drizzle ORM `db` handle and the raw postgres.js client.
 */
export function createDb(url?: string): DbInstance {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required. Start Supabase locally with `pnpm run db:start` ' +
        'and set DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres.',
    );
  }

  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  return { db, client };
}
