import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { resolve } from 'node:path';

// Precedence mirrors bootstrap.ts but with a hard preference for the
// non-pooling URL when both are present. Drizzle's migrator acquires an
// advisory lock on a single connection, which doesn't play well with
// Supabase's pgBouncer transaction-mode pooler (POSTGRES_URL). On Vercel
// the Supabase Marketplace integration provisions both URLs; CI/deploy
// should prefer the direct connection.
const connectionString =
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error(
    'No Postgres connection string set. Locally: `pnpm run db:start` and ' +
      'export DATABASE_URL. On Vercel: the Supabase Marketplace integration ' +
      'provisions POSTGRES_URL_NON_POOLING automatically.',
  );
}

// `max: 1` keeps migrations single-threaded; required by drizzle's migrator
// because it acquires an advisory lock on a single connection.
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

console.log(`Running migrations against ${maskUrl(connectionString)}...`);

await migrate(db, {
  migrationsFolder: resolve(import.meta.dirname ?? '.', '..', 'drizzle'),
});

console.log('Migrations complete.');

await client.end();
