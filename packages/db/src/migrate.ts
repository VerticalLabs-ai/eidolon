import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { resolve } from 'node:path';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is required. Start Supabase locally with `pnpm run db:start` ' +
      'and export DATABASE_URL before running migrations.',
  );
}

// `max: 1` keeps migrations single-threaded; required by drizzle's migrator
// because it acquires an advisory lock on a single connection.
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

console.log('Running migrations...');

await migrate(db, {
  migrationsFolder: resolve(import.meta.dirname ?? '.', '..', 'drizzle'),
});

console.log('Migrations complete.');

await client.end();
